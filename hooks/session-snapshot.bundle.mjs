function a(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var F=10;function h(t,r=4){return[...new Set(t.filter(o=>o.length>0))].slice(0,r).map(o=>o.length>80?o.slice(0,80):o)}function m(t,r){if(r.length===0)return"";let e=r.map(n=>`"${a(n)}"`).join(", ");return`
    For full details:
    ${a(t)}(
      queries: [${e}],
      source: "session-events"
    )`}function x(t,r){if(t.length===0)return"";let e=new Map;for(let f of t){let S=f.data,p=e.get(S);p||(p={ops:new Map},e.set(S,p));let d;f.type==="file_write"?d="write":f.type==="file_read"?d="read":f.type==="file_edit"?d="edit":d=f.type,p.ops.set(d,(p.ops.get(d)??0)+1)}let o=Array.from(e.entries()).slice(-F),c=[],i=[];for(let[f,{ops:S}]of o){let p=Array.from(S.entries()).map(([b,y])=>`${b}\xD7${y}`).join(", "),d=f.split("/").pop()??f;c.push(`    ${a(d)} (${a(p)})`),i.push(`${d} ${Array.from(S.keys()).join(" ")}`)}let s=h(i);return[`  <files count="${e.size}">`,...c,m(r,s),"  </files>"].join(`
`)}function B(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t)e.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <errors count="${t.length}">`,...e,m(r,o),"  </errors>"].join(`
`)}function J(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let c=h(o);return[`  <decisions count="${n.length}">`,...n,m(r,c),"  </decisions>"].join(`
`)}function X(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),s.type==="rule_content"?n.push(`    ${a(s.data)}`):n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let c=h(o);return[`  <rules count="${n.length}">`,...n,m(r,c),"  </rules>"].join(`
`)}function G(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t)e.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <git count="${t.length}">`,...e,m(r,o),"  </git>"].join(`
`)}function z(t){if(t.length===0)return"";let r=[],e={};for(let s of t)try{let u=JSON.parse(s.data);typeof u.subject=="string"?r.push(u.subject):typeof u.taskId=="string"&&typeof u.status=="string"&&(e[u.taskId]=u.status)}catch{}if(r.length===0)return"";let n=new Set(["completed","deleted","failed"]),o=Object.keys(e).sort((s,u)=>Number(s)-Number(u)),c=[];for(let s=0;s<r.length;s++){let u=o[s],f=u?e[u]??"pending":"pending";n.has(f)||c.push(r[s])}if(c.length===0)return"";let i=[];for(let s of c)i.push(`    [pending] ${a(s)}`);return i.join(`
`)}function H(t,r){let e=z(t);if(!e)return"";let n=[];for(let s of t)try{let u=JSON.parse(s.data);typeof u.subject=="string"&&n.push(u.subject)}catch{}let o=h(n);return[`  <task_state count="${e.split(`
`).length}">`,e,m(r,o),"  </task_state>"].join(`
`)}function P(t,r,e){if(t.length===0&&r.length===0)return"";let n=[],o=[];if(t.length>0){let s=t[t.length-1];n.push(`    cwd: ${a(s.data)}`),o.push("working directory")}for(let s of r)n.push(`    ${a(s.data)}`),o.push(s.data);let c=h(o);return["  <environment>",...n,m(e,c),"  </environment>"].join(`
`)}function Q(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t){let s=i.type==="subagent_completed"?"completed":i.type==="subagent_launched"?"launched":"unknown";e.push(`    [${s}] ${a(i.data)}`),n.push(`subagent ${i.data}`)}let o=h(n);return[`  <subagents count="${t.length}">`,...e,m(r,o),"  </subagents>"].join(`
`)}function U(t,r){if(t.length===0)return"";let e=new Map;for(let s of t){let u=s.data.split(":")[0].trim();e.set(u,(e.get(u)??0)+1)}let n=[],o=[];for(let[s,u]of e)n.push(`    ${a(s)} (${u}\xD7)`),o.push(`skill ${s} invocation`);let c=h(o);return[`  <skills count="${t.length}">`,...n,m(r,c),"  </skills>"].join(`
`)}function V(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let c=h(o);return[`  <roles count="${n.length}">`,...n,m(r,c),"  </roles>"].join(`
`)}function K(t){if(t.length===0)return"";let r=t[t.length-1];return`  <intent mode="${a(r.data)}"/>`}var W=3,Y=400;function Z(t,r){let e=[...t];return e.length<=r?t:e.slice(0,r).join("")}function tt(t){if(t.length===0)return"";let e=t.slice(-W).map(n=>{let o=Z(n.data??"",Y);return o?`    <message>${a(o)}</message>`:""}).filter(Boolean);return e.length===0?"":[`  <recent_user_messages count="${e.length}">`,...e,"  </recent_user_messages>"].join(`
`)}function st(t,r){let e=r?.compactCount??1,n=r?.searchTool??"ctx_search",o=new Date().toISOString(),c=[],i=[],s=[],u=[],f=[],S=[],p=[],d=[],b=[],y=[],$=[],k=[],v=[];for(let g of t)switch(g.category){case"file":c.push(g);break;case"task":i.push(g);break;case"rule":s.push(g);break;case"decision":u.push(g);break;case"cwd":f.push(g);break;case"error":S.push(g);break;case"env":p.push(g);break;case"git":d.push(g);break;case"subagent":b.push(g);break;case"intent":y.push(g);break;case"skill":$.push(g);break;case"role":k.push(g);break;case"user-prompt":v.push(g);break}let l=[];l.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let E=x(c,n);E&&l.push(E);let _=B(S,n);_&&l.push(_);let w=J(u,n);w&&l.push(w);let q=X(s,n);q&&l.push(q);let j=G(d,n);j&&l.push(j);let L=H(i,n);L&&l.push(L);let T=P(f,p,n);T&&l.push(T);let C=Q(b,n);C&&l.push(C);let M=U($,n);M&&l.push(M);let I=V(k,n);I&&l.push(I);let N=K(y);N&&l.push(N);let A=tt(v);A&&l.push(A);let O=`<session_resume events="${t.length}" compact_count="${e}" generated_at="${o}">`,R="</session_resume>",D=l.join(`

`);return D?`${O}

${D}

${R}`:`${O}
${R}`}export{st as buildResumeSnapshot,z as renderTaskState};
