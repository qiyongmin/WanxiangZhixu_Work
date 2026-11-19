import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../icons';

type ProviderId='openai'|'anthropic'|'gemini'|'glm'|'kimi';
interface Provider {id:ProviderId;label:string;subtitle:string;homepage:string;interface:string;}
export const PROVIDERS:readonly Provider[]=[
  {id:'openai',label:'OpenAI / ChatGPT',subtitle:'OpenAI API Platform',homepage:'https://platform.openai.com/docs',interface:'Responses API'},
  {id:'anthropic',label:'Anthropic / Claude',subtitle:'Claude API',homepage:'https://platform.claude.com/docs/en/api/overview',interface:'Messages API'},
  {id:'gemini',label:'Google / Gemini',subtitle:'Google AI Studio',homepage:'https://ai.google.dev/gemini-api/docs',interface:'Interactions API'},
  {id:'glm',label:'GLM / 智谱',subtitle:'BigModel 开放平台',homepage:'https://docs.bigmodel.cn/',interface:'OpenAI-compatible / GLM API'},
  {id:'kimi',label:'Kimi / Moonshot',subtitle:'Moonshot AI',homepage:'https://platform.kimi.com/docs',interface:'Moonshot API'},
];

type Status={saved:Record<string,boolean>};
function errorText(error:unknown){return error instanceof Error?error.message:'Request failed';}

export function ProviderConnections(){
  const [status,setStatus]=useState<Status|null>(null);
  const [loadError,setLoadError]=useState('');
  const [active,setActive]=useState<ProviderId|null>(null);
  const [key,setKey]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [confirmRemove,setConfirmRemove]=useState(false);
  const load=async()=>{
    setLoadError('');
    try{
      const r=await fetch('/api/work-hub/provider-keys',{headers:{Accept:'application/json'},cache:'no-store'});
      const body=await r.json() as {ok:boolean;data?:Status;error?:string};
      if(!r.ok||!body.ok||!body.data)throw new Error('Provider vault unavailable');
      setStatus(body.data);
    }catch(error){setLoadError(errorText(error));}
  };
  // Defer initial fetch until page is mounted. No user key is ever fetched back.
  useEffect(()=>{void load();},[]);
  const choose=(id:ProviderId)=>{
    setActive(current=>current===id?null:id);setKey('');setMessage('');setConfirmRemove(false);
  };
  const save=async(event:FormEvent)=>{
    event.preventDefault();
    if(!active||busy||key.length<8)return;
    setBusy(true);setMessage('');
    try{
      const r=await fetch('/api/work-hub/provider-keys',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({action:'save',provider:active,key})
      });
      const body=await r.json() as {ok:boolean;data?:Status};
      if(!r.ok||!body.ok||!body.data)throw new Error('Could not save key in local vault');
      setStatus(body.data);setKey('');setMessage('API Key saved to the local encrypted vault. No external API call was made.');
      setActive(null);
    }catch(error){setMessage(errorText(error)+' · Key not saved.');}
    finally{setBusy(false);}
  };
  const remove=async()=>{
    if(!active||busy)return;
    setBusy(true);setMessage('');
    try{
      const r=await fetch('/api/work-hub/provider-keys',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({action:'remove',provider:active})
      });
      const body=await r.json() as {ok:boolean;data?:Status};
      if(!r.ok||!body.ok||!body.data)throw new Error('Could not remove key');
      setStatus(body.data);setKey('');setMessage('Saved provider key removed from the local vault.');
      setActive(null);setConfirmRemove(false);
    }catch(error){setMessage(errorText(error));}
    finally{setBusy(false);}
  };
  return <section className="agent-provider-section" aria-label="Model provider integrations">
    <div className="agent-provider-head">
      <div><span className="agent-access-eyebrow">CONNECTIONS</span>
        <h2>Model providers</h2>
        <p className="muted">Choose a provider, then paste its API Key. This stores credentials locally only; it does not enable model calls or send Work materials to external services.</p>
      </div>
      <button type="button" className="btn" onClick={()=>void load()}><Icon name="repeat" size={15}/> Refresh</button>
    </div>
    {loadError?<div role="alert" className="error-bar">Could not read provider status: {loadError}</div>:null}
    <div className="agent-provider-grid">
      {PROVIDERS.map(provider=><article key={provider.id}
        className={active===provider.id?'agent-provider-card is-selected':'agent-provider-card'}
        data-provider={provider.id}>
        <div className="agent-provider-card-top">
          <span className="agent-provider-monogram" data-provider={provider.id}>{provider.id==='openai'?'O':provider.id==='anthropic'?'A':provider.id==='gemini'?'G':provider.id==='glm'?'智':'K'}</span>
          <span className={status?.saved[provider.id]?'agent-provider-status is-saved':'agent-provider-status'}>
            {status?.saved[provider.id]?'Key saved':'Not configured'}</span>
        </div>
        <h3>{provider.label}</h3>
        <p>{provider.subtitle} · {provider.interface}</p>
        <div className="agent-provider-actions">
          <button type="button" className="btn btn-primary" aria-expanded={active===provider.id}
            onClick={()=>choose(provider.id)}>{active===provider.id?'Close':'Configure'} <Icon name="chevron-right" size={14}/></button>
          <a href={provider.homepage} target="_blank" rel="noopener noreferrer" className="btn">Docs <Icon name="open" size={13}/></a>
        </div>
      </article>)}
    </div>
    {active ? <form className="agent-provider-config" onSubmit={event=>void save(event)}
      aria-label={'Configure '+(PROVIDERS.find(x=>x.id===active)?.label??active)}>
      <div><h3>{PROVIDERS.find(x=>x.id===active)?.label}</h3>
        <p className="muted">Paste a provider-specific API Key. It is sent only to the localhost Work server, encrypted outside the project directory, and never returned to this browser.</p>
      </div>
      <label>API Key
        <input type="password" value={key} autoComplete="off" spellCheck={false}
          placeholder="Paste API Key (not shown again)" minLength={8} maxLength={4096}
          onChange={event=>setKey(event.target.value)} required/>
      </label>
      <div className="agent-provider-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy||key.trim().length<8}>
          <Icon name="check" size={15}/> {busy?'Saving…':'Save API Key'}</button>
        <button type="button" className="btn" onClick={()=>choose(active)} disabled={busy}>Cancel</button>
        {status?.saved[active]?<button type="button" className="btn btn-danger" disabled={busy}
          onClick={()=>setConfirmRemove(true)}>Remove saved key</button>:null}
      </div>
      {confirmRemove?<div className="agent-provider-remove-confirm">
        Remove this provider key? This does not delete any Work records.
        <button type="button" className="btn btn-danger" onClick={()=>void remove()} disabled={busy}>Confirm remove</button>
        <button type="button" className="btn" onClick={()=>setConfirmRemove(false)}>Cancel</button>
      </div>:null}
    </form>:null}
    {message?<p className="agent-provider-feedback" role="status">{message}</p>:null}
    <p className="agent-provider-safety"><Icon name="check" size={16}/> Local-only development vault. No key is stored in React build files, browser storage, Work DB or project ZIP backups. Corporate SSO, approved secrets manager and outbound provider access must be reviewed before enabling production integrations.</p>
  </section>;
}
