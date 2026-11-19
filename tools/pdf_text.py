from __future__ import annotations
import re, zlib

_OBJ = re.compile(rb'(\d+)\s+(\d+)\s+obj\b(.*?)\bendobj\b', re.S)
_PAGE = re.compile(rb'/Type\s*/Page\b')
_REF = re.compile(rb'(\d+)\s+\d+\s+R')


def _stream(obj: bytes) -> bytes | None:
    match = re.search(rb'\bstream\r?\n', obj)
    if not match:
        return None
    end = obj.find(b'endstream', match.end())
    if end < 0:
        return None
    raw = obj[match.end():end].rstrip(b'\r\n')
    if re.search(rb'/Filter\s*(?:\[\s*)?/FlateDecode\b', obj[:match.start()]):
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            return None
    return raw


def _decode_unicode(hex_value: bytes) -> str:
    try:
        raw = bytes.fromhex(re.sub(rb'\s+', b'', hex_value).decode('ascii'))
        if len(raw) % 2 == 0:
            return raw.decode('utf-16-be', errors='replace')
        return raw.decode('utf-8', errors='replace')
    except Exception:
        return ''


def _cmap(obj: bytes) -> dict[bytes, str]:
    raw = _stream(obj)
    if raw is None:
        return {}
    mapping: dict[bytes, str] = {}
    for block in re.findall(rb'beginbfchar(.*?)endbfchar', raw, re.S):
        for src, dst in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            try: mapping[bytes.fromhex(src.decode())] = _decode_unicode(dst)
            except ValueError: pass
    for block in re.findall(rb'beginbfrange(.*?)endbfrange', raw, re.S):
        for line in block.splitlines():
            m = re.search(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', line)
            if m:
                try:
                    start, end = int(m[1],16), int(m[2],16); width=len(m[1])//2
                    dst_raw=bytes.fromhex(m[3].decode()); base=int.from_bytes(dst_raw,'big')
                    for offset, code in enumerate(range(start,end+1)):
                        mapping[code.to_bytes(width,'big')] = chr(base+offset)
                except Exception: pass
                continue
            m = re.search(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]', line, re.S)
            if m:
                try:
                    start, end = int(m[1],16), int(m[2],16); width=len(m[1])//2
                    values=re.findall(rb'<([0-9A-Fa-f]+)>',m[3])
                    for code,dst in zip(range(start,end+1),values):mapping[code.to_bytes(width,'big')] = _decode_unicode(dst)
                except Exception: pass
    return mapping


def _literal_bytes(value: bytes) -> bytes:
    out=bytearray();i=0
    while i<len(value):
        ch=value[i]
        if ch!=92:
            out.append(ch);i+=1;continue
        i+=1
        if i>=len(value):break
        ch=value[i]
        escapes={ord('n'):10,ord('r'):13,ord('t'):9,ord('b'):8,ord('f'):12,ord('('):40,ord(')'):41,92:92}
        if ch in escapes:out.append(escapes[ch]);i+=1;continue
        if 48<=ch<=55:
            digits=bytes([ch]);i+=1
            while i<len(value) and len(digits)<3 and 48<=value[i]<=55:digits+=bytes([value[i]]);i+=1
            out.append(int(digits,8));continue
        if ch in (10,13):
            if ch==13 and i+1<len(value) and value[i+1]==10:i+=2
            else:i+=1
            continue
        out.append(ch);i+=1
    return bytes(out)


def _decode_bytes(raw: bytes, cmap: dict[bytes,str]) -> str:
    if cmap:
        lengths=sorted({len(k) for k in cmap},reverse=True);out=[];i=0
        while i<len(raw):
            matched=False
            for length in lengths:
                key=raw[i:i+length]
                if key in cmap:out.append(cmap[key]);i+=length;matched=True;break
            if not matched:
                b=raw[i:i+1];out.append(b.decode('cp1252',errors='replace'));i+=1
        return ''.join(out)
    for enc in ('utf-16-be','utf-8','cp1252'):
        try:
            if enc=='utf-16-be' and (len(raw)%2 or not raw.startswith((b'\x00',b'\xfe\xff'))):continue
            return raw.decode(enc)
        except UnicodeDecodeError:pass
    return raw.decode('latin1',errors='replace')


def _font_maps(page: bytes, objects: dict[int,bytes]) -> dict[str,dict[bytes,str]]:
    resources=page
    m=re.search(rb'/Resources\s+(\d+)\s+\d+\s+R',page)
    if m:resources=objects.get(int(m[1]),page)
    font_blob=b''
    m=re.search(rb'/Font\s*<<(.*?)>>',resources,re.S)
    if m:font_blob=m[1]
    else:
        m=re.search(rb'/Font\s+(\d+)\s+\d+\s+R',resources)
        if m:font_blob=objects.get(int(m[1]),b'')
    result={}
    for name,ref in re.findall(rb'/([^\s/<>()\[\]]+)\s+(\d+)\s+\d+\s+R',font_blob):
        font=objects.get(int(ref),b'');cm={}
        tu=re.search(rb'/ToUnicode\s+(\d+)\s+\d+\s+R',font)
        if tu:cm=_cmap(objects.get(int(tu[1]),b''))
        result[name.decode('latin1')]=cm
    return result

_TOKEN = re.compile(
    rb'/(?P<font>[^\s/<>()\[\]]+)\s+[-+]?\d*\.?\d+\s+Tf|'
    rb'(?P<literal>\((?:\\.|[^\\)])*\))\s*(?P<lop>Tj|\'|\")|'
    rb'(?P<hex><[0-9A-Fa-f\s]+>)\s*Tj|'
    rb'(?P<array>\[(?:[^\]]|\](?!\s*TJ))*\])\s*TJ|'
    rb'(?P<newline>T\*|[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+T[dD])',re.S)


def _text_from_stream(raw: bytes, font_maps: dict[str,dict[bytes,str]]) -> str:
    current={};parts=[]
    for match in _TOKEN.finditer(raw):
        if match.group('font') is not None:
            current=font_maps.get(match.group('font').decode('latin1'),{});continue
        if match.group('newline') is not None:
            if parts and parts[-1]!='\n':parts.append('\n')
            continue
        chunks=[]
        if match.group('literal') is not None:chunks=[_literal_bytes(match.group('literal')[1:-1])]
        elif match.group('hex') is not None:
            try:chunks=[bytes.fromhex(re.sub(rb'\s+',b'',match.group('hex')[1:-1]).decode())]
            except ValueError:chunks=[]
        elif match.group('array') is not None:
            body=match.group('array')[1:-1]
            for lit,hx in re.findall(rb'\(([^)]*(?:\\.[^)]*)*)\)|<([0-9A-Fa-f\s]+)>',body):
                if lit:chunks.append(_literal_bytes(lit))
                elif hx:
                    try:chunks.append(bytes.fromhex(re.sub(rb'\s+',b'',hx).decode()))
                    except ValueError:pass
        text=''.join(_decode_bytes(x,current) for x in chunks)
        if text:parts.append(text)
    text=''.join(parts)
    text=re.sub(r'[ \t\xa0]+',' ',text)
    text=re.sub(r' *\n *','\n',text)
    text=re.sub(r'\n{3,}','\n\n',text)
    return text.strip()


def extract_pdf_text(raw: bytes) -> dict:
    if not raw.startswith(b'%PDF-'):raise ValueError('Not a PDF file')
    objects={int(m[1]):m[3] for m in _OBJ.finditer(raw)}
    pages=[(num,obj) for num,obj in objects.items() if _PAGE.search(obj)]
    texts=[]
    for _,page in pages:
        maps=_font_maps(page,objects);refs=[]
        m=re.search(rb'/Contents\s*\[(.*?)\]',page,re.S)
        if m:refs=[int(x) for x in re.findall(rb'(\d+)\s+\d+\s+R',m[1])]
        else:
            m=re.search(rb'/Contents\s+(\d+)\s+\d+\s+R',page)
            if m:refs=[int(m[1])]
        page_parts=[]
        for ref in refs:
            stream=_stream(objects.get(ref,b''))
            if stream is not None:
                text=_text_from_stream(stream,maps)
                if text:page_parts.append(text)
        if page_parts:texts.append('\n'.join(page_parts))
    if not texts:
        # Fallback for simple PDFs whose page tree/resources could not be resolved.
        seen=[]
        for obj in objects.values():
            stream=_stream(obj)
            if stream is None:continue
            text=_text_from_stream(stream,{})
            if len(text)>=20 and text not in seen:seen.append(text)
        texts=seen
    text='\n\n'.join(x for x in texts if x).strip()
    printable=sum(ch.isprintable() or ch in '\n\t' for ch in text)
    quality=(printable/max(1,len(text))) if text else 0
    status='extracted' if len(text)>=80 and quality>.92 else ('partial' if text else 'empty')
    return {'text':text,'pageCount':len(pages),'status':status,'extractor':'stdlib-pdf-v1'}
