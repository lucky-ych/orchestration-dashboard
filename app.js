'use strict';
const $ = id => document.getElementById(id);
const active = new Set(['ANALYSIS_ASSIGNED','ASSIGNED','WORKING','VALIDATING','AI_REVIEW','PUBLISHING']);
const attention = new Set(['INTERRUPTED','BLOCKED','MERGED_POLICY_DISCREPANCY']);
const labels = {ANALYSIS_ASSIGNED:'코드 분석 중',SCOPE_WAIT:'수정 범위 대기',ASSIGNED:'할당됨',WORKING:'구현 중',VALIDATING:'검증 중',VALIDATION_WAIT:'공용 CI 대기',AI_REVIEW:'AI 리뷰',PUBLISHING:'게시 중',READY:'준비',DEPENDENCY_WAIT:'선행 작업 대기',TRACKING:'총괄 추적',REVIEW_WAIT:'리뷰 대기',DONE:'완료',CANCELLED:'취소',INTERRUPTED:'중단',BLOCKED:'차단',MERGED_POLICY_DISCREPANCY:'정책 확인',WAITING:'대기',RUNNING:'실행 중',COMPLETE:'완료',success:'통과',failure:'실패',error:'오류'};
let data = null, endpoint = '', paused = false, filter = 'all', busy = false, generation = 0, failed = false;
const localDashboard = document.querySelector('meta[name="workflow-dashboard-local"]')?.content === 'same-origin';
if (localDashboard) endpoint = new URL('/v1/status', location.href).href;
else try { endpoint = localStorage.getItem('workflow-dashboard-endpoint') || ''; } catch {}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function validEndpoint(value) { const u = new URL(value); if (u.username || u.password || u.search || u.hash || !u.hostname || !(u.protocol === 'https:' || (u.protocol === 'http:' && (['localhost','127.0.0.1'].includes(u.hostname) || localDashboard && u.origin === location.origin)))) throw new Error('HTTPS 주소 또는 현재 관제실의 고정 주소를 사용하세요. 인증 정보·쿼리·해시는 사용할 수 없습니다.'); if(u.pathname==='/' || !u.pathname)u.pathname='/v1/status'; return u.href; }
function num(value, digits=1) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(digits) : '—'; }
function age(value) { if (!Number.isFinite(value) || value <= 0) return '시각 미확인'; const seconds = Math.max(0, Date.now()/1000-value); return seconds<60 ? '방금 전' : seconds<3600 ? `${Math.floor(seconds/60)}분 전` : seconds<86400 ? `${Math.floor(seconds/3600)}시간 전` : `${Math.floor(seconds/86400)}일 전`; }
function pill(text, warn=false) { return el('span',text,`pill${warn?' warn':''}`); }
function github(repo, kind, number, text) { const a=el('a',text); if (/^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(number) && number>0) { a.href=`https://github.com/${repo}/${kind}/${number}`; a.target='_blank'; a.rel='noopener noreferrer'; a.setAttribute('aria-label',`${repo} ${kind==='issues'?'이슈':'PR'} #${number} GitHub에서 열기`); } return a; }
function matches(job) { return filter==='all' || filter==='active' && active.has(job.state) || filter==='ready' && ['READY','SCOPE_WAIT'].includes(job.state) || filter==='review' && job.state==='REVIEW_WAIT' || filter==='attention' && attention.has(job.state); }
function setConnection(message, tone) { $('connection-state').textContent=message; $('connection-dot').className=`dot ${tone||''}`; }
function updateAge() { if(data) $('last-update').textContent=`${failed?'마지막 성공':'조회'} ${age(data.generated_at)}${paused?' · 자동 갱신 정지':''}${failed?' · 현재 상태 미확인':''}`; }
function render() {
  const available = data.repositories.every(r=>r.availability==='available');
  const jobs=data.repositories.flatMap(r=>r.jobs.map(j=>({...j,repository:r.repository})));
  for (const [key,test] of [['active',j=>active.has(j.state)],['ready',j=>['READY','SCOPE_WAIT'].includes(j.state)],['review',j=>j.state==='REVIEW_WAIT'],['attention',j=>attention.has(j.state)]]) $('count-'+key).textContent=data.repositories.some(r=>r.availability==='available')?`${jobs.filter(test).length}${available?'':'+'}`:'—';
  const codeCount=jobs.filter(j=>active.has(j.state)).length, ciCount=data.repositories.flatMap(r=>r.ci).filter(c=>c.state==='RUNNING').length;
  $('count-active').textContent=available?String(codeCount+ciCount):'—';
  $('active-breakdown').textContent=available?`코드 ${codeCount} · CI ${ciCount}`:'코드 · CI 미확인 (일부 저장소 조회 불가)';
  updateAge();
  const selected=$('repository').value; $('repository').replaceChildren(el('option','모든 저장소')); $('repository').firstChild.value='';
  for(const r of data.repositories) { const option=el('option',r.repository||'설정 확인 필요');option.value=r.repository||'unknown';$('repository').append(option); } $('repository').value=selected;
  $('hosts').replaceChildren();
  for (const h of data.hosts) {
    const card=el('article',undefined,'host'), head=el('div',undefined,'host-head'), name=el('div'); name.append(el('h3',h.name),el('span',h.roles.length?h.roles.join(' · '):'역할 미설정','roles'));
    head.append(name,pill(h.connection_status==='not_configured'?'워커 등록 대기':h.heartbeat_status==='fresh'?'하트비트 정상':h.heartbeat_status==='stale'?'하트비트 오래됨':'하트비트 미확인',h.heartbeat_status!=='fresh'));card.append(head);
    if (h.address) card.append(el('p',`Tailscale ${h.address}`,'host-meta'));
    card.append(el('p',`하트비트 ${age(h.heartbeat_at)} · 자원 ${h.metrics_source==='local'?'로컬 측정':'하트비트 측정'} ${age(h.metrics_at)}${h.metrics_status!=='fresh'?' (오래됨/미확인)':''}`,'host-meta'));
    const grid=el('div',undefined,'metric-grid');
    for(const [title,value,unit] of [['CPU 사용',h.metrics.cpu_percent,'%'],['메모리 여유',h.metrics.available_memory_gb,'GiB'],['디스크 여유',h.metrics.free_disk_gb,'GiB']]) { const m=el('div',undefined,'metric');m.append(el('label',title),el('strong',num(value,title==='CPU 사용'?0:1)),el('small',unit));grid.append(m); }card.append(grid);
    const foot=el('div',undefined,'host-foot'), detail=el('button','기기 상세 ↗');detail.addEventListener('click',()=>showHost(h));foot.append(el('span',`코드 ${h.active_jobs ?? '미확인'} · CI ${h.active_ci ?? '미확인'} · 예약 ${h.reservations.complete?h.reservations.count:'미확인'}건`),detail);card.append(foot);$('hosts').append(card);
  }
  if(!data.hosts.length) $('hosts').append(el('div','확인할 수 있는 기기가 없습니다.','empty'));
  renderQueue(jobs);renderCI();
}
function renderQueue(jobs=null) {
  if(!data)return;
  jobs ||= data.repositories.flatMap(r=>r.jobs.map(j=>({...j,repository:r.repository})));
  const repo=$('repository').value, query=$('search').value.trim().toLocaleLowerCase();
  const visible=jobs.filter(j=>(!repo||j.repository===repo)&&matches(j)&&(`${j.issue} ${j.target_number||''} ${j.title}`.toLocaleLowerCase().includes(query)));
  $('queue-total').textContent=`${visible.length} / ${jobs.length}`;$('jobs').replaceChildren();
  const waitLabels={github_forbidden:'GitHub 접근 거부 · 저장소 접근 권한을 확인하세요',github_rate_limited:'GitHub 호출 제한 · 재시도 시각까지 대기하세요',github_unavailable:'GitHub 승인 조회 불가 · 연결 상태를 확인하세요'};
  $('repository-status').textContent=data.repositories.flatMap(r=>r.availability!=='available'?[`${r.repository||'저장소 설정'}: 조회 불가 · 작업 수와 예약 합계는 불완전합니다.`]:r.claim_wait&&waitLabels[r.claim_wait.reason]?[`${r.repository}: 신규 할당 대기 · ${waitLabels[r.claim_wait.reason]} · 기존 작업은 계속됩니다.`]:[]).join(' / ');
  for(const j of visible) {
    const tr=el('tr'),title=el('td'),isPR=j.target_kind==='pr',target=j.target_number||j.issue;
    title.append(el('span',j.repository,'repo-name'),el('span',`${isPR?'PR':'이슈'} #${target} ${j.title}`,'issue-title'));
    if(isPR&&target!==j.issue)title.append(el('small',`연결 이슈 #${j.issue}`,'job-note'));
    if(j.reason_label)title.append(el('p',j.reason_label,'job-reason'));
    if(j.next_action)title.append(el('p',j.next_action,'job-action'));
    if(j.dependencies_waiting?.length)title.append(el('small',`선행 작업: ${j.dependencies_waiting.map(n=>'#'+n).join(', ')}`,'job-note'));
    if(j.required_environments?.length)title.append(el('small',`필수 실제 환경: ${j.required_environments.join(', ')}`,'job-note'));
    const state=el('td');state.append(pill(labels[j.state]||'미확인',attention.has(j.state)));
    if(Number.isSafeInteger(j.assignments))state.append(el('small',`할당 ${j.assignments}회`,'job-note'));
    if(Number.isSafeInteger(j.pr_cycles))state.append(el('small',`PR 작업 ${j.pr_cycles}회`,'job-note'));
    if(j.failures) {const counts=[['validation','검증'],['review','리뷰'],['protocol','실행']].filter(([k])=>Number.isSafeInteger(j.failures[k]));if(counts.length)state.append(el('small',`누적 실패: ${counts.map(([k,label])=>`${label} ${j.failures[k]}`).join(' · ')}`,'job-note'));}
    const hosts=el('td');hosts.append(el('span',`코드 ${j.code_worker||j.worker||'미할당'}`));
    if(j.ci_state)hosts.append(el('small',`CI ${j.ci_worker||'미할당'} · ${labels[j.ci_state]||'미확인'}`,'job-note'));
    if(j.last_ci_result)hosts.append(el('small',`최근 CI ${labels[j.last_ci_result]||'미확인'}`,'job-note'));
    const link=el('td');link.append(github(j.repository,isPR?'pull':'issues',target,'↗'));
    tr.append(title,state,hosts,el('td',age(j.updated)),link);$('jobs').append(tr);
  }
  if(!visible.length){const tr=el('tr'),td=el('td',jobs.length?'조건에 맞는 작업이 없습니다.':data.availability==='available'?'저장된 작업이 없습니다.':'조회 가능한 작업이 없습니다. 저장소 연결 상태를 확인하세요.','empty');td.colSpan=5;tr.append(td);$('jobs').append(tr);}
}
function renderCI() { $('ci').replaceChildren();const priority=c=>c.state==='RUNNING'?0:c.state==='WAITING'?1:2;const rows=data.repositories.flatMap(r=>r.ci.map(c=>({...c,repository:r.repository}))).sort((a,b)=>priority(a)-priority(b)||(b.updated||0)-(a.updated||0));for(const c of rows){const r={repository:c.repository};const row=el('div',undefined,'ci-row'),title=el('div');title.append(github(r.repository,c.issue?'issues':'pull',c.issue||c.pr,`${r.repository} / ${c.issue?'이슈':'PR'} #${c.issue||c.pr||'—'}`),el('small',`${c.context||'검증 컨텍스트 미확인'} · 기기 ${c.worker||'미할당'}`));row.append(title,pill(labels[c.result]||labels[c.state]||'미확인',['failure','error'].includes(c.result)||c.state==='INTERRUPTED'),el('code',c.head?c.head.slice(0,12):'SHA 미확인'),el('time',age(c.updated)));$('ci').append(row);}if(!$('ci').children.length)$('ci').append(el('div',data.availability==='available'?'저장된 CI 기록이 없습니다.':'CI 기록을 확인할 수 없습니다. 저장소 연결 상태를 확인하세요.','empty'));}
function showHost(h){const root=$('host-detail');root.replaceChildren(el('p','HOST DETAIL','eyebrow'),el('h2',h.name));const dl=el('dl');for(const [k,v] of [['워커 ID',h.id],['실행 중 코드',h.active_jobs ?? '미확인'],['실행 중 CI',h.active_ci ?? '미확인'],['설정된 역할',h.roles.join(' · ')||'미설정'],['저장소',h.repositories.join(', ')||'없음'],['하트비트',`${h.heartbeat_status} · ${age(h.heartbeat_at)}`],['자원 측정',`${h.metrics_status} · ${age(h.metrics_at)}`],['예약 메모리',`${num(h.reservations.memory_gb)} GiB`],['예약 디스크',`${num(h.reservations.disk_gb)} GiB`],['예약 CPU',`${num(h.reservations.cpu_cores)} cores`],['예약 집계',h.reservations.complete?'모든 설정 저장소 확인됨':'일부 비용 또는 저장소 미확인']])dl.append(el('dt',k),el('dd',v));root.append(dl,el('p','중단된 소유자의 예약도 포함합니다. 기기의 데몬 실행 여부와 활성 작업 수는 별개입니다.'));$('host-dialog').showModal();}
async function refresh(){if(!endpoint||busy)return;busy=true;const version=generation;$('refresh').disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(endpoint,{credentials:'omit',cache:'no-store',signal:controller.signal,redirect:'error'});if(!response.ok)throw new Error('response');const next=await response.json();if(next.schema_version!==1||!Array.isArray(next.repositories)||!Array.isArray(next.hosts))throw new Error('schema');if(version!==generation)return;data=next;failed=false;setConnection(next.availability==='available'?'비공개 조회 연결됨':'연결됨 · 일부 저장소 확인 필요',next.availability==='available'?'live':'warning');render();}catch{if(version!==generation)return;failed=true;setConnection('연결 실패 · Tailscale, 계정 권한과 브라우저 로컬 네트워크 권한을 확인하세요','warning');if(data)render();else $('last-update').textContent='운영 상태 미확인';}finally{clearTimeout(timeout);busy=false;$('refresh').disabled=!endpoint;}}
$('settings').addEventListener('click',()=>{$('endpoint').value=endpoint;$('form-error').textContent='';$('connection-dialog').showModal();});
$('close-settings').addEventListener('click',()=>$('connection-dialog').close());$('close-host').addEventListener('click',()=>$('host-dialog').close());
$('connection-form').addEventListener('submit',event=>{event.preventDefault();try{endpoint=validEndpoint($('endpoint').value.trim());generation++;try{localStorage.setItem('workflow-dashboard-endpoint',endpoint);}catch{}$('connection-dialog').close();$('pause').disabled=false;refresh();}catch(error){$('form-error').textContent=error.message;}});
$('disconnect').addEventListener('click',()=>{generation++;try{localStorage.removeItem('workflow-dashboard-endpoint');}catch{}location.reload();});
$('refresh').addEventListener('click',refresh);$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'자동 갱신 재개':'자동 갱신 일시정지';$('pause').setAttribute('aria-pressed',String(paused));if(data)render();if(!paused)refresh();});
$('repository').addEventListener('change',()=>renderQueue());$('search').addEventListener('input',()=>renderQueue());document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});renderQueue();}));
setInterval(()=>{if(!paused&&!document.hidden)refresh();},15000);
setInterval(updateAge,1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateAge();if(!paused)refresh();}});
if(localDashboard){$('settings').textContent='현재 IP로 고정 연결';$('settings').disabled=true;}
if(endpoint){try{endpoint=validEndpoint(endpoint);$('pause').disabled=false;refresh();}catch{endpoint='';setConnection('저장된 주소를 확인하세요','warning');}}
