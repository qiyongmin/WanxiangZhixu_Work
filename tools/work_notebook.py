"""KB_Work Notes V3 — additive, page-level notebook storage and event timeline.

No implicit schema creation on GET. A controlled, backed-up migration creates
these tables. Old node.data.noteEntries and all old node revisions stay intact.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import re
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import work_hub_nodes as nodes
import work_hub_schema as schema
import work_hub_store as store
import work_hub_html
import work_hub_notes

DDL = (
"""CREATE TABLE IF NOT EXISTS work_note_sections(
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES records(id),
 title TEXT NOT NULL, role TEXT, position INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 UNIQUE(owner_id,role))""",
"CREATE INDEX IF NOT EXISTS work_note_sections_owner ON work_note_sections(owner_id,position)",
"""CREATE TABLE IF NOT EXISTS work_note_pages(
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES records(id),
 section_id TEXT NOT NULL REFERENCES work_note_sections(id),
 title TEXT NOT NULL, html TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, legacy_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)""",
"CREATE INDEX IF NOT EXISTS work_note_pages_section ON work_note_pages(section_id,archived_at,position)",
"CREATE INDEX IF NOT EXISTS work_note_pages_owner ON work_note_pages(owner_id,archived_at,updated_at)",
"""CREATE TABLE IF NOT EXISTS work_note_page_revisions(
 page_id TEXT NOT NULL REFERENCES work_note_pages(id),
 revision INTEGER NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL,
 actor TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL,
 PRIMARY KEY(page_id,revision))""",
"""CREATE TABLE IF NOT EXISTS work_note_page_links(
 page_id TEXT NOT NULL REFERENCES work_note_pages(id),
 target_node_id TEXT NOT NULL REFERENCES records(id),
 created_at TEXT NOT NULL, PRIMARY KEY(page_id,target_node_id))""",
"""CREATE TABLE IF NOT EXISTS work_note_events(
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES records(id),
 kind TEXT NOT NULL, title TEXT NOT NULL,
 event_date TEXT NOT NULL, event_time TEXT, timezone TEXT, instant_utc TEXT,
 summary_html TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)""",
"CREATE INDEX IF NOT EXISTS work_note_events_date ON work_note_events(event_date DESC,id)",
"CREATE INDEX IF NOT EXISTS work_note_events_owner ON work_note_events(owner_id,event_date DESC)",
"""CREATE TABLE IF NOT EXISTS work_note_event_pages(
 event_id TEXT NOT NULL REFERENCES work_note_events(id),page_id TEXT NOT NULL REFERENCES work_note_pages(id),
 PRIMARY KEY(event_id,page_id))""",
"""CREATE TABLE IF NOT EXISTS work_note_event_tasks(
 event_id TEXT NOT NULL REFERENCES work_note_events(id),task_id TEXT NOT NULL REFERENCES records(id),
 PRIMARY KEY(event_id,task_id))""",
"""CREATE TABLE IF NOT EXISTS work_note_event_revisions(
 event_id TEXT NOT NULL REFERENCES work_note_events(id),
 revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 actor TEXT NOT NULL, occurred_at TEXT NOT NULL,
 PRIMARY KEY(event_id,revision))""",
"""CREATE TABLE IF NOT EXISTS work_note_legacy_map(
 owner_id TEXT NOT NULL REFERENCES records(id), old_note_id TEXT NOT NULL,
 page_id TEXT NOT NULL UNIQUE REFERENCES work_note_pages(id),
 source_sha256 TEXT NOT NULL, original_node_revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,old_note_id))""",
"""CREATE TABLE IF NOT EXISTS work_note_migration_runs(
 id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
 source_count INTEGER NOT NULL, imported_count INTEGER NOT NULL,
 source_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0)""",
)
STATUS_KEY = 'notebook_v3_ready'
TYPES = ('journal','meeting','decision','milestone','other')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
CLOCK = re.compile(r'^(?:[01]\d|2[0-3]):[0-5]\d$')
MAX_PAGE_HTML = 1024 * 1024

def _err(message, code='notebook_invalid', status=400, **extra):
    raise nodes.NodeError(message,code=code,status=status,extra=extra)

def _ready(con):
    return con.execute("SELECT value FROM work_meta WHERE key=?", (STATUS_KEY,)).fetchone() is not None

def status(path=None):
    with nodes._reader(path) as con:
        ready=_ready(con)
        counts={}
        if ready:
            for table,label in [('work_note_pages','pages'),('work_note_sections','sections'),('work_note_events','events')]:
                counts[label]=con.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
        if ready:
            import work_notebook_v34 as v34
            if v34.ready(con):
                counts["timelineDates"] = con.execute("SELECT count(*) FROM work_note_page_timeline").fetchone()[0]
                return {'ready':True,'version':4,'counts':counts}
        return {'ready':ready,'version':3 if ready else 2,'counts':counts}

def _require(con):
    if not _ready(con):
        _err('Notes V3 migration has not been verified','notebook_migration_required',409)

def _node(con,identifier):
    row=nodes._row_or_404(con,identifier)
    index=nodes._Index(con)
    if row['kind'] not in ('initiative','knowledge_collection','topic','workstream','campaign','task','action'):
        _err('Only Work tree nodes have notebooks')
    chain=index.chain(identifier)
    if len(chain)>4 or not chain or any(index.rows[x]['archived_at'] or index.rows[x]['deleted_at'] for x in chain):
        _err('Notebook node must be an active L1/L2/L3 node')
    return row,chain[0]

def _same_root(con,a,b):
    _,top_a=_node(con,a)
    _,top_b=_node(con,b)
    if top_a!=top_b:_err('Cross-project references are not allowed','notebook_cross_root')
    return top_a

def _page(con,page_id,active=True):
    row=con.execute('SELECT * FROM work_note_pages WHERE id=?',(page_id,)).fetchone()
    if row is None or (active and row['archived_at']):_err('Page not found','notebook_page_not_found',404)
    return row

def _section(con,owner,section_id):
    row=con.execute('SELECT * FROM work_note_sections WHERE owner_id=? AND id=? AND archived_at IS NULL',
                    (owner,section_id)).fetchone()
    if not row:_err('Section not found for this notebook','notebook_section_not_found',404)
    return row

def _validate_title(value):
    if not isinstance(value,str) or not 1<=len(value.strip())<=200:
        _err('Title must be 1–200 characters')
    return value.strip()

def _validate_html(value):
    if not isinstance(value,str) or len(value.encode('utf-8'))>MAX_PAGE_HTML:
        _err('Page HTML exceeds the 1MiB limit')
    try:work_hub_html.validate_strict(value)
    except ValueError:_err('Unsafe page HTML','note_html_invalid')
    return value

def _int(value,default=30,maximum=100):
    try:i=int(value)
    except (ValueError,TypeError):_err('Invalid pagination')
    if not 0<=i<=maximum:_err('Invalid pagination')
    return i

def _stamp():return store._now()
def _uid(prefix):return prefix+uuid.uuid4().hex
def _dto(row):return dict(row)
def _section_create(con,owner,title,role=None,migrating=False):
    if not migrating:_node(con,owner)
    title=_validate_title(title)
    count=con.execute('SELECT coalesce(max(position),-1)+1 FROM work_note_sections WHERE owner_id=?',(owner,)).fetchone()[0]
    now=_stamp()
    section_id=_uid('ns_')
    con.execute('INSERT INTO work_note_sections(id,owner_id,title,role,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                (section_id,owner,title,role,count,now,now))
    return _dto(con.execute('SELECT * FROM work_note_sections WHERE id=?',(section_id,)).fetchone())

def _find_or_create(con,owner,role,title):
    row=con.execute('SELECT * FROM work_note_sections WHERE owner_id=? AND role=? AND archived_at IS NULL',
                    (owner,role)).fetchone()
    return _dto(row) if row else _section_create(con,owner,title,role)

def migrate(path=None):
    """Explicit one-transaction migration; caller MUST create/verify standalone backup."""
    with nodes._writer(path) as con:
        # Preserve original Notes and Node revisions untouched; do not reformat legacy HTML.
        records=con.execute("SELECT id,revision,data,created_at,updated_at FROM records WHERE kind IN "
          "('initiative','knowledge_collection','topic','workstream','campaign','task','action') "
          "ORDER BY id").fetchall()
        candidates=[]
        for record in records:
            index=nodes._Index(con)
            # Historical Notes survive even when a Node is archived/deleted.
            if len(index.chain(record['id']))>4:continue
            data=json.loads(record['data'])
            entries=data.get('noteEntries')
            if isinstance(entries,list):
                for entry in entries:
                    if isinstance(entry,dict) and all(isinstance(entry.get(k),str) for k in ('id','title','html')):
                        candidates.append((record,entry['id'],entry['title'],entry['html']))
            elif isinstance(data.get('notes'),str) and data['notes'].strip():
                legacy=data['notes']
                candidates.append((record,'note_legacynote','Note 1',
                    '<p>'+html.escape(legacy,quote=False).replace('\n','<br>')+'</p>'))
        payload=sorted((r['id'],id,title,body) for r,id,title,body in candidates)
        source_hash=hashlib.sha256(json.dumps(payload,ensure_ascii=False).encode()).hexdigest()
        for sql in DDL:con.execute(sql)
        if _ready(con):
            # Idempotent re-run verifies mapped source copies still match.
            mapped=con.execute('SELECT count(*) FROM work_note_legacy_map').fetchone()[0]
            for record,old,title,body in candidates:
                digest=hashlib.sha256(json.dumps([title,body],ensure_ascii=False).encode()).hexdigest()
                check=con.execute('SELECT source_sha256 FROM work_note_legacy_map WHERE owner_id=? AND old_note_id=?',
                                  (record['id'],old)).fetchone()
                if not check or check[0]!=digest:_err('Legacy source has changed after migration','notebook_migration_conflict',409)
            return {'ready':True,'sourceCount':len(candidates),'mappedCount':mapped,'sourceHash':source_hash,'changed':False}
        seen=set()
        for record,old,title,body in candidates:
            key=(record['id'],old)
            if key in seen:_err('Duplicate legacy Note IDs for one owner','notebook_duplicate_legacy',409)
            seen.add(key)
            existing=con.execute('SELECT id FROM work_note_sections WHERE owner_id=? AND role=?',
                                 (record['id'],'general')).fetchone()
            section={'id':existing[0]} if existing else _section_create(con,record['id'],'General','general',migrating=True)
            pid='np_'+hashlib.sha256((record['id']+':'+old).encode()).hexdigest()[:32]
            now=record['updated_at']
            position=con.execute('SELECT count(*) FROM work_note_pages WHERE section_id=?',(section['id'],)).fetchone()[0]
            con.execute('INSERT INTO work_note_pages(id,owner_id,section_id,title,html,position,legacy_id,created_at,updated_at) '
                        'VALUES(?,?,?,?,?,?,?,?,?)',(pid,record['id'],section['id'],title,body,position,old,record['created_at'],now))
            con.execute('INSERT INTO work_note_page_revisions(page_id,revision,title,html,actor,source,occurred_at) '
                        'VALUES(?,?,?,?,?,?,?)',(pid,1,title,body,'migration','legacy:node-revision:'+str(record['revision']),now))
            digest=hashlib.sha256(json.dumps([title,body],ensure_ascii=False).encode()).hexdigest()
            con.execute('INSERT INTO work_note_legacy_map VALUES(?,?,?,?,?)',(record['id'],old,pid,digest,record['revision']))
        count=con.execute('SELECT count(*) FROM work_note_legacy_map').fetchone()[0]
        if count!=len(candidates):_err('Source/import count mismatch','notebook_migration_mismatch',409)
        for record,old,title,body in candidates:
            data=con.execute('SELECT p.title,p.html FROM work_note_pages p JOIN work_note_legacy_map m ON p.id=m.page_id '
                             'WHERE m.owner_id=? AND m.old_note_id=?',(record['id'],old)).fetchone()
            if not data or data['title']!=title or data['html']!=body:
                _err('Legacy migration content comparison failed','notebook_migration_mismatch',409)
        now=_stamp()
        con.execute('INSERT INTO work_note_migration_runs VALUES(?,?,?,?,?,?,?)',
                    (_uid('nm_'),now,now,len(candidates),count,source_hash,1))
        con.execute('INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)',(STATUS_KEY,'1',now))
        return {'ready':True,'sourceCount':len(candidates),'mappedCount':count,'sourceHash':source_hash,'changed':True}

def sections_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con)
        owner=params.get('id');_node(con,owner)
        sections=[_dto(r) for r in con.execute('SELECT * FROM work_note_sections WHERE owner_id=? AND archived_at IS NULL ORDER BY position,id',(owner,))]
        count={r['section_id']:r['n'] for r in con.execute('SELECT section_id,count(*) n FROM work_note_pages WHERE owner_id=? AND archived_at IS NULL GROUP BY section_id',(owner,))}
        for entry in sections:entry['pageCount']=count.get(entry['id'],0)
        links=[_dto(row) for row in con.execute(
          'SELECT p.id,p.title,p.owner_id,p.section_id,l.target_node_id FROM work_note_page_links l '
          'JOIN work_note_pages p ON p.id=l.page_id WHERE l.target_node_id=? AND p.archived_at IS NULL ORDER BY p.updated_at DESC LIMIT 100',(owner,))]
        return {'sections':sections,'linkedPages':links}

def pages_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con);owner=params.get('id');_node(con,owner)
        section=params.get('section') or ''
        if isinstance(section,list):section=section[0] if section else ''
        if section:_section(con,owner,section)
        limit=_int(params.get('limit',40),40,100);offset=_int(params.get('offset',0),0,1000000)
        q=(params.get('q') or '').strip()
        if len(q)>200:_err('Search too long')
        clause='owner_id=? AND archived_at IS NOT NULL' if params.get('archived') in ('1','true') else 'owner_id=? AND archived_at IS NULL'
        args=[owner]
        if section:clause+=' AND section_id=?';args.append(section)
        if q:clause+=' AND (title LIKE ? OR html LIKE ?)';args.extend(['%'+q+'%']*2)
        total=con.execute('SELECT count(*) FROM work_note_pages WHERE '+clause,args).fetchone()[0]
        # Never return HTML for list views, especially for large notebooks.
        rows=[_dto(r) for r in con.execute('SELECT id,owner_id,section_id,title,position,revision,'
            'created_at,updated_at,legacy_id FROM work_note_pages WHERE '+clause+
            ' ORDER BY position,id LIMIT ? OFFSET ?',(*args,limit,offset))]
        return {'items':rows,'total':total,'limit':limit,'offset':offset}

def _page_detail(con,p):
    result=_dto(p)
    import work_notebook_v34 as v34
    if v34.ready(con):
        result['timelineDate']=v34._date_get(con,p['id'])
    result['links']=[r[0] for r in con.execute('SELECT target_node_id FROM work_note_page_links WHERE page_id=?',(p['id'],))]
    import work_notebook_v35 as v35
    if v35.ready(con):
        doc=v35._doc_row(con,p['id'])
        if doc:
            result['documentJson']=json.loads(doc['json_text'])
            result['documentFormat']='json'
            result['documentSourceRevision']=doc['source_revision']
    if p['legacy_id']:
        result['legacyHistory']=True
    # Agent review remains in the legacy node/write table; no rewriting.
    writes=con.execute('SELECT write_id,state FROM work_agent_writes WHERE record_id=? '
                      'AND (ref=? OR ref=?) AND state=?',
                      (p['owner_id'],p['legacy_id'],p['id'],'unconfirmed')).fetchall()
    result['unconfirmedWriteIds']=[r['write_id'] for r in writes]
    return result

def page_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con)
        owner=params.get('id');_node(con,owner)
        page_id=params.get('page') or ''
        if not page_id and params.get('note'):
            match=con.execute('SELECT page_id FROM work_note_legacy_map WHERE owner_id=? AND old_note_id=?',
                              (owner,params['note'])).fetchone()
            page_id=match[0] if match else ''
        page=_page(con,page_id,active=params.get('archived')!='1')
        if page['owner_id']!=owner:_err('Page does not belong to this Notebook','notebook_owner_mismatch',403)
        return _page_detail(con,page)

def history_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con);page=_page(con,params.get('page') or '')
        _node(con,page['owner_id'])
        rows=[_dto(r) for r in con.execute('SELECT revision,title,actor,source,occurred_at FROM work_note_page_revisions '
          'WHERE page_id=? ORDER BY revision DESC LIMIT 100',(page['id'],))]
        return {'items':rows,'legacyHistory':bool(page['legacy_id'])}

def revision_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con)
        page=_page(con,params.get('page') or '',active=False)
        _node(con,page['owner_id'])
        revision=params.get('revision')
        try:rev=int(revision)
        except (ValueError,TypeError):_err('Invalid Page revision')
        if rev<1:_err('Invalid Page revision')
        record=con.execute('SELECT revision,title,html,actor,source,occurred_at FROM work_note_page_revisions '
                           'WHERE page_id=? AND revision=?',(page['id'],rev)).fetchone()
        if not record:_err('Revision not found','notebook_revision_not_found',404)
        return _dto(record)


def section_action(body,path=None):
    with nodes._writer(path) as con:
        _require(con);owner=body.get('id');_node(con,owner)
        action=body.get('action')
        if action=='notebook-section-create':
            return {'section':_section_create(con,owner,body.get('title'))}
        sec=None if action=='notebook-section-reorder' else _section(con,owner,body.get('sectionId'))
        import work_notebook_v34 as v34
        if v34.ready(con) and sec is not None and sec['role']=='journal':
            _err('The Journal / Timeline Section is protected','notebook_journal_protected',409)
        if action=='notebook-section-rename':
            name=_validate_title(body.get('title'))
            con.execute('UPDATE work_note_sections SET title=?,updated_at=? WHERE id=?',(name,_stamp(),sec['id']))
        elif action=='notebook-section-reorder':
            ids=body.get('ids');expected=body.get('expectedIds')
            if v34.ready(con):
                before=[r[0] for r in con.execute("SELECT id FROM work_note_sections WHERE owner_id=? "
                    "AND archived_at IS NULL AND role IS NOT 'journal' ORDER BY position,id",(owner,))]
            else:
                before=[r[0] for r in con.execute('SELECT id FROM work_note_sections WHERE owner_id=? AND archived_at IS NULL ORDER BY position,id',(owner,))]
            if not isinstance(ids,list) or len(ids)!=len(set(ids)) or sorted(ids)!=sorted(before):
                _err('Only reorderable sibling Sections can be reordered','notebook_scope')
            if expected!=before:_err('Section order changed in another tab','notebook_conflict',409,currentIds=before)
            for i,sid in enumerate(ids):
                con.execute('UPDATE work_note_sections SET position=?,updated_at=? WHERE id=?',
                    (i+1 if v34.ready(con) else i,_stamp(),sid))
        elif action=='notebook-section-delete':
            if con.execute('SELECT 1 FROM work_note_pages WHERE section_id=? LIMIT 1',(sec['id'],)).fetchone():
                _err('Move or permanently retain all Pages before archiving a Section; archived Pages must remain recoverable',
                     'notebook_section_not_empty',409)
            con.execute('UPDATE work_note_sections SET archived_at=?,role=NULL WHERE id=?',(_stamp(),sec['id']))
        else:_err('Unknown section action')
        return {'changed':True}

def _make_page(con,owner,section,title,body='',legacy=None):
    _node(con,owner);_section(con,owner,section)
    title=_validate_title(title);body=_validate_html(body)
    pid=_uid('np_');now=_stamp()
    index=con.execute('SELECT coalesce(max(position),-1)+1 FROM work_note_pages WHERE section_id=?',(section,)).fetchone()[0]
    con.execute('INSERT INTO work_note_pages(id,owner_id,section_id,title,html,position,legacy_id,created_at,updated_at) '
                'VALUES(?,?,?,?,?,?,?,?,?)',(pid,owner,section,title,body,index,legacy,now,now))
    con.execute('INSERT INTO work_note_page_revisions VALUES(?,?,?,?,?,?,?)',(pid,1,title,body,'user','notebook:create',now))
    return _page_detail(con,_page(con,pid))

def page_action(body,path=None):
    with nodes._writer(path) as con:
        _require(con);action=body.get('action')
        if action=='notebook-page-create':
            owner=body.get('id');_node(con,owner)
            section=body.get('sectionId')
            if not section:section=_find_or_create(con,owner,'general','General')['id']
            pg=_make_page(con,owner,section,body.get('title') or 'Untitled Page',body.get('html') or '')
            import work_notebook_v34 as v34
            if v34.ready(con):
                v34.ensure_page_date(con,pg['id'],body.get('timelineDate'))
                pg=_page_detail(con,_page(con,pg['id']))
            return {'page':pg}
        if action=='notebook-page-reorder':
            owner=body.get('id');_node(con,owner)
            section=_section(con,owner,body.get('sectionId'))
            rows=con.execute('SELECT id FROM work_note_pages WHERE section_id=? AND archived_at IS NULL ORDER BY position,id',(section['id'],)).fetchall()
            before=[r['id'] for r in rows]
            ids=body.get('ids');expected=body.get('expectedIds')
            if not isinstance(ids,list) or len(ids)!=len(set(ids)) or sorted(ids)!=sorted(before):
                _err('Only Pages from the selected Section may be reordered','notebook_scope')
            if expected!=before:_err('Page order changed in another window','notebook_conflict',409,currentIds=before)
            for position,pid in enumerate(ids):
                con.execute('UPDATE work_note_pages SET position=? WHERE id=?',(position,pid))
            stamp=_stamp()
            con.execute('INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)',
                        ('notebook:page-order-audit:'+uuid.uuid4().hex,
                         json.dumps({'owner':owner,'section':section['id'],'before':before,'after':ids}),stamp))
            return {'changed':ids!=before,'ids':ids}
        page=_page(con,body.get('pageId') or '',active=action!='notebook-page-restore')
        _node(con,page['owner_id'])
        import work_notebook_v34 as v34
        if v34.ready(con):
            section_row=con.execute('SELECT archived_at FROM work_note_sections WHERE id=?',
                                    (page['section_id'],)).fetchone()
            if section_row and section_row['archived_at']:
                _err('Restore the Section before modifying its Pages','notebook_section_archived',409)
        if action=='notebook-page-restore' and not page['archived_at']:
            _err('Page is already active','notebook_invalid_state')
        if action=='notebook-page-link' or action=='notebook-page-unlink':
            target=body.get('targetNodeId');_same_root(con,page['owner_id'],target)
            if action=='notebook-page-link':
                con.execute('INSERT OR IGNORE INTO work_note_page_links VALUES(?,?,?)',(page['id'],target,_stamp()))
            else:
                con.execute('DELETE FROM work_note_page_links WHERE page_id=? AND target_node_id=?',(page['id'],target))
            return {'page':_page_detail(con,_page(con,page['id']))}
        base=body.get('baseRevision')
        if type(base) is not int or base!=page['revision']:
            _err('Page Revision conflict','revision_conflict',409,currentRevision=page['revision'])
        title,content=page['title'],page['html'];section=page['section_id'];archived=page['archived_at']
        if action=='notebook-page-save':
            title=_validate_title(body.get('title'))
            content=_validate_html(body.get('html'))
            import work_notebook_v35 as v35
            v35.legacy_write_allowed(con,page['id'],content)
        elif action=='notebook-page-move':
            section=body.get('sectionId');_section(con,page['owner_id'],section)
        elif action=='notebook-page-archive':
            archived=_stamp()
        elif action=='notebook-page-restore':
            archived=None
        else:_err('Unknown Page action')
        if (title,content,section,archived)==(page['title'],page['html'],page['section_id'],page['archived_at']):
            return {'page':_page_detail(con,page),'changed':False}
        now=_stamp();rev=base+1
        con.execute('UPDATE work_note_pages SET title=?,html=?,section_id=?,archived_at=?,revision=?,updated_at=? WHERE id=?',
                    (title,content,section,archived,rev,now,page['id']))
        con.execute('INSERT INTO work_note_page_revisions VALUES(?,?,?,?,?,?,?)',(page['id'],rev,title,content,'user',action,now))
        if action=='notebook-page-move':
            import work_notebook_v34 as v34
            v34.ensure_page_date(con,page['id'])
        import work_notebook_v35 as v35
        if v35.ready(con) and v35._doc_row(con,page['id']):
            con.execute('UPDATE work_note_v35_docs SET source_revision=? WHERE page_id=?', (rev,page['id']))
            doc=v35._doc_row(con,page['id'])
            con.execute('INSERT INTO work_note_v35_history VALUES(?,?,?,?,?)',
                        (page['id'],rev,doc['json_text'],doc['markdown_text'],doc['html_text']))
            con.execute('INSERT INTO work_note_v35_index_outbox VALUES(?,?,?,?) '
                        'ON CONFLICT(page_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,updated_at=excluded.updated_at',
                        (page['id'],rev,'pending',now))
        return {'page':_page_detail(con,_page(con,page['id'],active=False)),'changed':True}

def _event_stamp(date,time=None,timezone=None):
    if not isinstance(date,str) or not DAY.fullmatch(date):_err('Event Date must be YYYY-MM-DD')
    try:day=dt.date.fromisoformat(date)
    except ValueError:_err('Invalid Event Date')
    if not time:
        if timezone:_err('Timezone requires a specific Event Time')
        return date,None,None,None
    if not isinstance(time,str) or not CLOCK.fullmatch(time) or not isinstance(timezone,str) or not timezone:
        _err('Event Time must have an IANA timezone')
    try:
        zone=ZoneInfo(timezone)
        local=dt.datetime.combine(day,dt.time.fromisoformat(time),tzinfo=zone)
    except (ZoneInfoNotFoundError,ValueError):_err('Invalid Event timezone')
    utc=local.astimezone(dt.timezone.utc)
    if utc.astimezone(zone).strftime('%Y-%m-%d %H:%M')!=f'{date} {time}':
        _err('Event time does not exist in this timezone')
    alternate=local.replace(fold=1).astimezone(dt.timezone.utc)
    if alternate!=utc and alternate.astimezone(zone).strftime('%Y-%m-%d %H:%M')==f'{date} {time}':
        _err('Ambiguous Event time at daylight saving transition; choose another time')
    return date,time,timezone,utc.isoformat()

def _event(con,event_id):
    e=con.execute('SELECT * FROM work_note_events WHERE id=? AND archived_at IS NULL',(event_id,)).fetchone()
    if not e:_err('Event not found','notebook_event_not_found',404)
    return e

def _event_detail(con,event):
    e=_dto(event)
    e['pageIds']=[r[0] for r in con.execute('SELECT page_id FROM work_note_event_pages WHERE event_id=?',(event['id'],))]
    e['taskIds']=[r[0] for r in con.execute('SELECT task_id FROM work_note_event_tasks WHERE event_id=?',(event['id'],))]
    e['linkedPages']=[dict(r) for r in con.execute(
        'SELECT p.id,p.title,p.owner_id,p.section_id,p.revision FROM work_note_event_pages link '
        'JOIN work_note_pages p ON p.id=link.page_id WHERE link.event_id=? AND p.archived_at IS NULL',(event['id'],))]
    e['linkedTasks']=[dict(r) for r in con.execute(
        'SELECT t.id,t.title,t.status FROM work_note_event_tasks link JOIN records t ON t.id=link.task_id '
        'WHERE link.event_id=? AND t.deleted_at IS NULL',(event['id'],))]
    chain=nodes._Index(con).chain(event['owner_id']);e['rootId']=chain[0]
    e['sourcePath']=[{'id':x,'title':nodes._Index(con).rows[x]['title']} for x in chain]
    return e

def _event_revision(con,e):
    con.execute('INSERT INTO work_note_event_revisions VALUES(?,?,?,?,?)',
                (e['id'],e['revision'],json.dumps(_event_detail(con,e),ensure_ascii=False),'user',_stamp()))

def event_action(body,path=None):
    with nodes._writer(path) as con:
        _require(con);action=body.get('action')
        if action=='notebook-quick-capture':
            owner=body.get('id');_node(con,owner)
            sec=_find_or_create(con,owner,'journal','Journal')
            title=body.get('title') or 'Quick Note · '+str(body.get('eventDate') or '')
            page=_make_page(con,owner,sec['id'],title,_validate_html(body.get('html') or ''))
            import work_notebook_v34 as v34
            if v34.ready(con):
                v34.ensure_page_date(con,page['id'],body.get('eventDate'))
                page=_page_detail(con,_page(con,page['id']))
            event_body=dict(body,action='notebook-event-create',kind='journal',title=title,
                            pageIds=[page['id']])
        elif action=='notebook-event-create':
            event_body=body;page=None;owner=body.get('id');_node(con,owner)
        else:
            event_body=body;page=None
            current=_event(con,body.get('eventId') or '');owner=current['owner_id']
            base=body.get('baseRevision')
            if type(base) is not int or base!=current['revision']:
                _err('Event Revision conflict','revision_conflict',409,currentRevision=current['revision'])
        if event_body['action']=='notebook-event-create':
            kind=event_body.get('kind')
            if kind not in TYPES:_err('Unknown Event type')
            title=_validate_title(event_body.get('title'))
            date,time,tz,instant=_event_stamp(event_body.get('eventDate'),event_body.get('eventTime'),event_body.get('timezone'))
            summary=_validate_html(event_body.get('html') or '')
            now=_stamp();eid=_uid('ne_')
            con.execute('INSERT INTO work_note_events(id,owner_id,kind,title,event_date,event_time,timezone,instant_utc,summary_html,created_at,updated_at) '
                        'VALUES(?,?,?,?,?,?,?,?,?,?,?)',(eid,owner,kind,title,date,time,tz,instant,summary,now,now))
        elif action=='notebook-event-save':
            eid=current['id'];kind=event_body.get('kind',current['kind'])
            if kind not in TYPES:_err('Unknown Event type')
            title=_validate_title(event_body.get('title',current['title']))
            date,time,tz,instant=_event_stamp(event_body.get('eventDate',current['event_date']),
                event_body.get('eventTime',current['event_time']),event_body.get('timezone',current['timezone']))
            summary=_validate_html(event_body.get('html',current['summary_html']))
            con.execute('UPDATE work_note_events SET kind=?,title=?,event_date=?,event_time=?,timezone=?,instant_utc=?,'
                        'summary_html=?,revision=revision+1,updated_at=? WHERE id=?',
                        (kind,title,date,time,tz,instant,summary,_stamp(),eid))
        elif action=='notebook-event-archive':
            eid=current['id'];con.execute('UPDATE work_note_events SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?',(_stamp(),_stamp(),eid))
        else:_err('Unknown Event action')
        if action!='notebook-event-archive':
            # Page/Task links can be updated transactionally; links always stay inside same L1 root.
            if 'pageIds' in event_body:
                ids=event_body['pageIds']
                if not isinstance(ids,list) or len(ids)!=len(set(ids)) or len(ids)>100:_err('Invalid linked Pages')
                for pid in ids:
                    pg=_page(con,pid);_same_root(con,owner,pg['owner_id'])
                con.execute('DELETE FROM work_note_event_pages WHERE event_id=?',(eid,))
                con.executemany('INSERT INTO work_note_event_pages VALUES(?,?)',[(eid,pid) for pid in ids])
            if 'taskIds' in event_body:
                ids=event_body['taskIds']
                if not isinstance(ids,list) or len(ids)!=len(set(ids)) or len(ids)>100:_err('Invalid linked Tasks')
                for task in ids:
                    r,_root=_node(con,task)
                    _same_root(con,owner,task)
                    if r['kind'] not in ('task','action'):_err('Milestones may link Tasks only')
                con.execute('DELETE FROM work_note_event_tasks WHERE event_id=?',(eid,))
                con.executemany('INSERT INTO work_note_event_tasks VALUES(?,?)',[(eid,tid) for tid in ids])
        if action=='notebook-event-save':
            import work_notebook_v34 as v34
            v34.sync_event_date(con,current,date,event_body)
        event=_event(con,eid) if action!='notebook-event-archive' else con.execute('SELECT * FROM work_note_events WHERE id=?',(eid,)).fetchone()
        _event_revision(con,event)
        result={'event':_event_detail(con,event)}
        if page:result['page']=page
        return result

def event_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con)
        owner=params.get('id');_node(con,owner)
        event=_event(con,params.get('event') or '')
        _same_root(con,owner,event['owner_id'])
        return _event_detail(con,event)


def timeline_view(params,path=None):
    with nodes._reader(path) as con:
        _require(con);_,root=_node(con,params.get('id'))
        index=nodes._Index(con)
        members=[identifier for identifier,row in index.rows.items() if index.is_tree(row) and not row['deleted_at']
                 and not row['archived_at'] and index.top(identifier)==root and len(index.chain(identifier))<=3]
        if not members:return {'items':[],'total':0,'rootId':root}
        limit=_int(params.get('limit',40),40,100);offset=_int(params.get('offset',0),0,1000000)
        source=params.get('source')
        if source:
            if source not in members:_err('Timeline source is outside this project')
            members=[source]
        clause='owner_id IN ('+','.join('?' for _ in members)+') AND archived_at IS NULL'
        args=list(members)
        kind=params.get('kind')
        if kind:
            if kind not in TYPES:_err('Invalid Event type')
            clause+=' AND kind=?';args.append(kind)
        for col,key,cmp in [('event_date','from','>='),('event_date','to','<=')]:
            date=params.get(key)
            if date:
                _event_stamp(date)
                clause+=f' AND {col} {cmp} ?';args.append(date)
        total=con.execute('SELECT count(*) FROM work_note_events WHERE '+clause,args).fetchone()[0]
        rows=[_event_detail(con,r) for r in con.execute('SELECT * FROM work_note_events WHERE '+clause+
              ' ORDER BY event_date DESC,coalesce(event_time,\'\') DESC,id DESC LIMIT ? OFFSET ?',
              (*args,limit,offset))]
        return {'items':rows,'total':total,'rootId':root,'limit':limit,'offset':offset}
