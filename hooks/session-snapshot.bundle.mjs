function a(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var M=10;function h(t,r=4){return[...new Set(t.filter(o=>o.length>0))].slice(0,r).map(o=>o.length>80?o.slice(0,80):o)}function m(t,r){if(r.length===0)return"";let s=r.map(n=>`"${a(n)}"`).join(", ");return`
    For full details:
    ${a(t)}(
      queries: [${s}],
      source: "session-events"
    )`}function A(t,r){if(t.length===0)return"";let s=new Map;for(let l of t){let b=l.data,p=s.get(b);p||(p={ops:new Map},s.set(b,p));let g;l.type==="file_write"?g="write":l.type==="file_read"?g="read":l.type==="file_edit"?g="edit":g=l.type,p.ops.set(g,(p.ops.get(g)??0)+1)}let o=Array.from(s.entries()).slice(-M),u=[],i=[];for(let[l,{ops:b}]of o){let p=Array.from(b.entries()).map(([S,y])=>`${S}\xD7${y}`).join(", "),g=l.split("/").pop()??l;u.push(`    ${a(g)} (${a(p)})`),i.push(`${g} ${Array.from(b.keys()).join(" ")}`)}let e=h(i);return[`  <files count="${s.size}">`,...u,m(r,e),"  </files>"].join(`
`)}function x(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t)s.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <errors count="${t.length}">`,...s,m(r,o),"  </errors>"].join(`
`)}function D(t,r){if(t.length===0)return"";let s=new Set,n=[],o=[];for(let e of t)s.has(e.data)||(s.add(e.data),n.push(`    ${a(e.data)}`),o.push(e.data));if(n.length===0)return"";let u=h(o);return[`  <decisions count="${n.length}">`,...n,m(r,u),"  </decisions>"].join(`
`)}function F(t,r){if(t.length===0)return"";let s=new Set,n=[],o=[];for(let e of t)s.has(e.data)||(s.add(e.data),e.type==="rule_content"?n.push(`    ${a(e.data)}`):n.push(`    ${a(e.data)}`),o.push(e.data));if(n.length===0)return"";let u=h(o);return[`  <rules count="${n.length}">`,...n,m(r,u),"  </rules>"].join(`
`)}function R(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t)s.push(`    ${a(i.data)}`),n.push(i.data);let o=h(n);return[`  <git count="${t.length}">`,...s,m(r,o),"  </git>"].join(`
`)}function B(t){if(t.length===0)return"";let r=[],s={};for(let e of t)try{let c=JSON.parse(e.data);typeof c.subject=="string"?r.push(c.subject):typeof c.taskId=="string"&&typeof c.status=="string"&&(s[c.taskId]=c.status)}catch{}if(r.length===0)return"";let n=new Set(["completed","deleted","failed"]),o=Object.keys(s).sort((e,c)=>Number(e)-Number(c)),u=[];for(let e=0;e<r.length;e++){let c=o[e],l=c?s[c]??"pending":"pending";n.has(l)||u.push(r[e])}if(u.length===0)return"";let i=[];for(let e of u)i.push(`    [pending] ${a(e)}`);return i.join(`
`)}function J(t,r){let s=B(t);if(!s)return"";let n=[];for(let e of t)try{let c=JSON.parse(e.data);typeof c.subject=="string"&&n.push(c.subject)}catch{}let o=h(n);return[`  <task_state count="${s.split(`
`).length}">`,s,m(r,o),"  </task_state>"].join(`
`)}function X(t,r,s){if(t.length===0&&r.length===0)return"";let n=[],o=[];if(t.length>0){let e=t[t.length-1];n.push(`    cwd: ${a(e.data)}`),o.push("working directory")}for(let e of r)n.push(`    ${a(e.data)}`),o.push(e.data);let u=h(o);return["  <environment>",...n,m(s,u),"  </environment>"].join(`
`)}function z(t,r){if(t.length===0)return"";let s=[],n=[];for(let i of t){let e=i.type==="subagent_completed"?"completed":i.type==="subagent_launched"?"launched":"unknown";s.push(`    [${e}] ${a(i.data)}`),n.push(`subagent ${i.data}`)}let o=h(n);return[`  <subagents count="${t.length}">`,...s,m(r,o),"  </subagents>"].join(`
`)}function G(t,r){if(t.length===0)return"";let s=new Map;for(let e of t){let c=e.data.split(":")[0].trim();s.set(c,(s.get(c)??0)+1)}let n=[],o=[];for(let[e,c]of s)n.push(`    ${a(e)} (${c}\xD7)`),o.push(`skill ${e} invocation`);let u=h(o);return[`  <skills count="${t.length}">`,...n,m(r,u),"  </skills>"].join(`
`)}function P(t){if(t.length===0)return"";let r=t[t.length-1];return`  <intent mode="${a(r.data)}"/>`}function V(t,r){let s=r?.compactCount??1,n=r?.searchTool??"ctx_search",o=new Date().toISOString(),u=[],i=[],e=[],c=[],l=[],b=[],p=[],g=[],S=[],y=[],k=[];for(let d of t)switch(d.category){case"file":u.push(d);break;case"task":i.push(d);break;case"rule":e.push(d);break;case"decision":c.push(d);break;case"cwd":l.push(d);break;case"error":b.push(d);break;case"env":p.push(d);break;case"git":g.push(d);break;case"subagent":S.push(d);break;case"intent":y.push(d);break;case"skill":k.push(d);break}let f=[];f.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let $=A(u,n);$&&f.push($);let v=x(b,n);v&&f.push(v);let w=D(c,n);w&&f.push(w);let E=F(e,n);E&&f.push(E);let q=R(g,n);q&&f.push(q);let L=J(i,n);L&&f.push(L);let _=X(l,p,n);_&&f.push(_);let j=z(S,n);j&&f.push(j);let T=G(k,n);T&&f.push(T);let C=P(y);C&&f.push(C);let O=`<session_resume events="${t.length}" compact_count="${s}" generated_at="${o}">`,I="</session_resume>",N=f.join(`

`);return N?`${O}

${N}

${I}`:`${O}
${I}`}export{V as buildResumeSnapshot,B as renderTaskState};
