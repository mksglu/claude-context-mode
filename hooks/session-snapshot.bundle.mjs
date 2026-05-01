function a(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var x=10;function h(t,r=4){return[...new Set(t.filter(o=>o.length>0))].slice(0,r).map(o=>o.length>80?o.slice(0,80):o)}function m(t,r){if(r.length===0)return"";let s=r.map(n=>`"${a(n)}"`).join(", ");return`
    For full details:
    ${a(t)}(
      queries: [${s}],
      source: "session-events"
    )`}function D(t,r){if(t.length===0)return"";let s=new Map;for(let l of t){let S=l.data,p=s.get(S);p||(p={ops:new Map},s.set(S,p));let d;l.type==="file_write"?d="write":l.type==="file_read"?d="read":l.type==="file_edit"?d="edit":d=l.type,p.ops.set(d,(p.ops.get(d)??0)+1)}let o=Array.from(s.entries()).slice(-x),c=[],i=[];for(let[l,{ops:S}]of o){let p=Array.from(S.entries()).map(([b,y])=>`${b}\xD7${y}`).join(", "),d=l.split("/").pop()??l;c.push(`    ${a(d)} (${a(p)})`),i.push(`${d} ${Array.from(S.keys()).join(" ")}`)}let e=h(i);return[`  <files count="${s.size}">`,...c,m(r,e),"  </files>"].join(`
`)}function R(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t)s.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <errors count="${t.length}">`,...s,m(r,o),"  </errors>"].join(`
`)}function F(t,r){if(t.length===0)return"";let s=new Set,n=[],o=[];for(let e of t)s.has(e.data)||(s.add(e.data),n.push(`    ${a(e.data)}`),o.push(e.data));if(n.length===0)return"";let c=h(o);return[`  <decisions count="${n.length}">`,...n,m(r,c),"  </decisions>"].join(`
`)}function B(t,r){if(t.length===0)return"";let s=new Set,n=[],o=[];for(let e of t)s.has(e.data)||(s.add(e.data),e.type==="rule_content"?n.push(`    ${a(e.data)}`):n.push(`    ${a(e.data)}`),o.push(e.data));if(n.length===0)return"";let c=h(o);return[`  <rules count="${n.length}">`,...n,m(r,c),"  </rules>"].join(`
`)}function J(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t)s.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <git count="${t.length}">`,...s,m(r,o),"  </git>"].join(`
`)}function X(t){if(t.length===0)return"";let r=[],s={};for(let e of t)try{let u=JSON.parse(e.data);typeof u.subject=="string"?r.push(u.subject):typeof u.taskId=="string"&&typeof u.status=="string"&&(s[u.taskId]=u.status)}catch{}if(r.length===0)return"";let n=new Set(["completed","deleted","failed"]),o=Object.keys(s).sort((e,u)=>Number(e)-Number(u)),c=[];for(let e=0;e<r.length;e++){let u=o[e],l=u?s[u]??"pending":"pending";n.has(l)||c.push(r[e])}if(c.length===0)return"";let i=[];for(let e of c)i.push(`    [pending] ${a(e)}`);return i.join(`
`)}function z(t,r){let s=X(t);if(!s)return"";let n=[];for(let e of t)try{let u=JSON.parse(e.data);typeof u.subject=="string"&&n.push(u.subject)}catch{}let o=h(n);return[`  <task_state count="${s.split(`
`).length}">`,s,m(r,o),"  </task_state>"].join(`
`)}function G(t,r,s){if(t.length===0&&r.length===0)return"";let n=[],o=[];if(t.length>0){let e=t[t.length-1];n.push(`    cwd: ${a(e.data)}`),o.push("working directory")}for(let e of r)n.push(`    ${a(e.data)}`),o.push(e.data);let c=h(o);return["  <environment>",...n,m(s,c),"  </environment>"].join(`
`)}function P(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t){let e=i.type==="subagent_completed"?"completed":i.type==="subagent_launched"?"launched":"unknown";s.push(`    [${e}] ${a(i.data)}`),n.push(`subagent ${i.data}`)}let o=h(n);return[`  <subagents count="${t.length}">`,...s,m(r,o),"  </subagents>"].join(`
`)}function Q(t,r){if(t.length===0)return"";let s=new Map;for(let e of t){let u=e.data.split(":")[0].trim();s.set(u,(s.get(u)??0)+1)}let n=[],o=[];for(let[e,u]of s)n.push(`    ${a(e)} (${u}\xD7)`),o.push(`skill ${e} invocation`);let c=h(o);return[`  <skills count="${t.length}">`,...n,m(r,c),"  </skills>"].join(`
`)}function U(t,r){if(t.length===0)return"";let s=new Set,n=[],o=[];for(let e of t)s.has(e.data)||(s.add(e.data),n.push(`    ${a(e.data)}`),o.push(e.data));if(n.length===0)return"";let c=h(o);return[`  <roles count="${n.length}">`,...n,m(r,c),"  </roles>"].join(`
`)}function V(t){if(t.length===0)return"";let r=t[t.length-1];return`  <intent mode="${a(r.data)}"/>`}function W(t,r){let s=r?.compactCount??1,n=r?.searchTool??"ctx_search",o=new Date().toISOString(),c=[],i=[],e=[],u=[],l=[],S=[],p=[],d=[],b=[],y=[],$=[],k=[];for(let f of t)switch(f.category){case"file":c.push(f);break;case"task":i.push(f);break;case"rule":e.push(f);break;case"decision":u.push(f);break;case"cwd":l.push(f);break;case"error":S.push(f);break;case"env":p.push(f);break;case"git":d.push(f);break;case"subagent":b.push(f);break;case"intent":y.push(f);break;case"skill":$.push(f);break;case"role":k.push(f);break}let g=[];g.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let v=D(c,n);v&&g.push(v);let w=R(S,n);w&&g.push(w);let E=F(u,n);E&&g.push(E);let q=B(e,n);q&&g.push(q);let L=J(d,n);L&&g.push(L);let j=z(i,n);j&&g.push(j);let _=G(l,p,n);_&&g.push(_);let T=P(b,n);T&&g.push(T);let C=Q($,n);C&&g.push(C);let O=U(k,n);O&&g.push(O);let I=V(y);I&&g.push(I);let N=`<session_resume events="${t.length}" compact_count="${s}" generated_at="${o}">`,M="</session_resume>",A=g.join(`

`);return A?`${N}

${A}

${M}`:`${N}
${M}`}export{W as buildResumeSnapshot,X as renderTaskState};
