/* Researchline night simulator: deterministic, minute-stepped, no randomness.
   Times are minutes after midnight. Shared verbatim by every variant. */
var RLSim = (function(){
  var START = 60, LIMIT_AT = 134, RESET_AT = 241;
  var REVIEW = 12, REREVIEW = 8;

  var TASKS = [
    {id:1, proj:'rna-seq',    ko:'배치 보정 다시 돌리기',      en:'Rerun batch correction',        run:52},
    {id:2, proj:'rna-seq',    ko:'발현 차이 표 갱신',          en:'Refresh the DE table',          run:38, dep:1},
    {id:3, proj:'rna-seq',    ko:'그림 3 다시 그리기',         en:'Redraw figure 3',               run:24, dep:2},
    {id:4, proj:'microbiome', ko:'다양성 지표 재계산',         en:'Recompute diversity metrics',   run:64, revise:true},
    {id:5, proj:'microbiome', ko:'메타데이터 정리',            en:'Clean up sample metadata',      run:29},
    {id:6, proj:'survival',   ko:'Cox 모델에 공변량 추가',     en:'Add covariates to the Cox model', run:61, revise:true},
    {id:7, proj:'survival',   ko:'생존 곡선 그림 갱신',        en:'Update the survival curves',    run:26, dep:6},
    {id:8, proj:'survival',   ko:'부트스트랩 1000회 서버 잡',  en:'Bootstrap ×1000 on the cluster', run:14, job:170}
  ];

  function byId(list, id){ for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

  /* opts: {ids:[...], width:1-6, policy:'switch'|'wait', revise:bool (default true), jobFail:bool} */
  function run(opts){
    var width = Math.max(1, Math.min(6, opts.width || 3));
    var policy = opts.policy === 'wait' ? 'wait' : 'switch';
    var useRevise = opts.revise !== false;
    var tasks = TASKS.filter(function(t){ return opts.ids.indexOf(t.id) !== -1; }).map(function(t){
      return {id:t.id, proj:t.proj, ko:t.ko, en:t.en, run:t.run, dep:(t.dep && opts.ids.indexOf(t.dep) !== -1) ? t.dep : null,
              revise: !!t.revise && useRevise, job:t.job || 0,
              phase:'queued', left:0, acct:null, slot:-1, lane:-1, submitAt:null, startAt:null, mergedAt:null, segs:[], held:0, moved:false};
    });
    var events = [], slots = [], t, i;
    for (i = 0; i < width; i++) slots.push(null);
    var jobs = [];
    var usage = {A:[], B:[], C:[]};
    var useA = 0.58, useB = 0.12, useC = 0.60;

    function ev(type, task, extra){ var e = {t:t, type:type, id: task ? task.id : null}; if (extra) for (var k in extra) e[k] = extra[k]; events.push(e); }
    function seg(task, kind){
      var last = task.segs[task.segs.length - 1];
      if (last && last.kind === kind && last.b === t && last.acct === task.acct) { last.b = t + 1; return; }
      task.segs.push({kind:kind, a:t, b:t + 1, acct:task.acct});
    }
    function limited(){ return t >= LIMIT_AT && t < RESET_AT; }
    function claudeAcct(){ if (!limited()) return 'A'; return policy === 'switch' ? 'B' : null; }
    function ready(task){ if (task.phase !== 'queued') return false; if (!task.dep) return true; var d = byId(tasks, task.dep); return d && d.phase === 'merged'; }

    var limitLogged = false, resetLogged = false, end = START;
    for (t = START; t < START + 24 * 60; t++) {
      if (t === LIMIT_AT && !limitLogged) { limitLogged = true; ev('limit', null, {acct:'A'}); }
      if (t === RESET_AT && !resetLogged) { resetLogged = true; ev('reset', null, {acct:'A'}); useA = 0; }

      /* account switch for runs that were on A when the limit hit */
      if (limited() && policy === 'switch') {
        slots.forEach(function(task){
          if (task && task.acct === 'A' && (task.phase === 'run' || task.phase === 'fix')) { task.acct = 'B'; task.moved = true; ev('move', task, {from:'A', to:'B'}); }
        });
      }

      /* start ready tasks in queue order */
      for (i = 0; i < slots.length; i++) {
        if (slots[i]) continue;
        var acct = claudeAcct();
        if (!acct) break;
        var next = null;
        for (var q = 0; q < tasks.length; q++) if (ready(tasks[q])) { next = tasks[q]; break; }
        if (!next) break;
        next.phase = 'run'; next.left = next.run; next.acct = acct; next.slot = i; next.lane = i; next.startAt = t; slots[i] = next;
        ev('start', next, {slot:i, acct:acct});
      }

      /* advance every occupied slot by one minute */
      var activeA = 0, activeB = 0;
      for (i = 0; i < slots.length; i++) {
        var s = slots[i]; if (!s) continue;
        if (s.phase === 'run' || s.phase === 'fix') {
          if (s.acct === 'A' && limited()) {
            if (policy === 'wait') { seg(s, 'hold'); s.held++; continue; }
          }
          if (s.acct === 'A') activeA++; else activeB++;
          seg(s, s.phase); s.left--;
          if (s.left <= 0) {
            if (s.job && s.phase === 'run') {
              /* the session submits the cluster job and ends; the job runs on the lab server */
              s.phase = 'job'; s.submitAt = t + 1; ev('submit', s);
              jobs.push({task:s, left:s.job, failed:false});
              slots[i] = null; s.slot = -1;
            } else {
              s.phase = s.phase === 'fix' ? 'rereview' : 'review';
              s.left = s.phase === 'review' ? REVIEW : REREVIEW;
              ev(s.phase === 'review' ? 'review' : 'rereview', s);
            }
          }
        } else if (s.phase === 'review' || s.phase === 'rereview') {
          seg(s, 'review'); s.left--;
          if (s.left <= 0) {
            if (s.phase === 'review' && s.revise) {
              ev('revise', s); s.phase = 'fix'; s.left = Math.round(s.run * 0.3);
              var a2 = claudeAcct(); s.acct = a2 || s.acct;
            } else {
              ev('approve', s); s.phase = 'merged'; s.mergedAt = t + 1; ev('merge', s);
              slots[i] = null;
            }
          }
        }
      }

      /* cluster jobs keep running with nobody watching */
      jobs.forEach(function(j){
        if (j.task.phase !== 'job') return;
        j.task.segs.push({kind:'job', a:t, b:t + 1, acct:null}); compact(j.task);
        j.left--;
        if (opts.jobFail && !j.failed && j.left === Math.round(j.task.job * 0.45)) {
          j.failed = true; ev('jobfail', j.task); ev('resubmit', j.task); j.left += 40;
        }
        if (j.left <= 0) { j.task.phase = 'merged'; j.task.mergedAt = t + 1; ev('jobdone', j.task); ev('merge', j.task); }
      });

      /* usage meters: share of the 5-hour window, illustrative */
      if (t < LIMIT_AT) useA = Math.min(1, 0.58 + (t - START) * (0.42 / (LIMIT_AT - START)));
      else if (t >= RESET_AT) useA = Math.min(1, useA + activeA * 0.0018);
      else useA = 1;
      useB = Math.min(0.97, useB + activeB * 0.0021);
      var reviewing = slots.filter(function(s){ return s && (s.phase === 'review' || s.phase === 'rereview'); }).length;
      useC = Math.min(0.97, useC + reviewing * 0.0006);
      usage.A.push(useA); usage.B.push(useB); usage.C.push(useC);

      var done = tasks.every(function(x){ return x.phase === 'merged'; });
      if (done) { end = t + 1; break; }
    }
    var moves = events.filter(function(e){ return e.type === 'move'; }).length;
    var held = tasks.reduce(function(a, x){ return a + x.held; }, 0);
    return {tasks:tasks, events:events, usage:usage, start:START, end:end, width:width, policy:policy,
            limitAt:LIMIT_AT, resetAt:RESET_AT, moves:moves, held:held,
            merged: tasks.filter(function(x){ return x.phase === 'merged'; }).length};
  }
  function compact(task){
    var n = task.segs.length; if (n < 2) return;
    var a = task.segs[n - 2], b = task.segs[n - 1];
    if (a.kind === b.kind && a.b === b.a && a.acct === b.acct) { a.b = b.b; task.segs.pop(); }
  }
  /* snapshot at minute m: what each task is doing, counters and meters */
  function at(res, m){
    var running = 0, merged = 0, held = 0, reviewing = 0, jobs = 0;
    var state = res.tasks.map(function(x){
      var cur = null;
      for (var i = 0; i < x.segs.length; i++) if (x.segs[i].a <= m && m < x.segs[i].b) { cur = x.segs[i]; break; }
      var isMerged = x.mergedAt !== null && x.mergedAt <= m;
      var k = isMerged ? 'merged' : (cur ? cur.kind : (x.startAt !== null && x.startAt <= m ? 'wait' : 'queued'));
      if (k === 'run' || k === 'fix') running++; if (k === 'hold') held++; if (k === 'review') reviewing++; if (k === 'job') jobs++; if (k === 'merged') merged++;
      return {id:x.id, kind:k, acct: cur ? cur.acct : null};
    });
    var idx = Math.max(0, Math.min(res.usage.A.length - 1, m - res.start));
    return {state:state, running:running, merged:merged, held:held, reviewing:reviewing, jobs:jobs,
            useA:res.usage.A[idx] || 0, useB:res.usage.B[idx] || 0, useC:res.usage.C[idx] || 0,
            events: res.events.filter(function(e){ return e.t <= m; })};
  }
  function clock(m){ var h = Math.floor(m / 60) % 24, mm = m % 60; return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm; }
  return {TASKS:TASKS, run:run, at:at, clock:clock, START:START, LIMIT_AT:LIMIT_AT, RESET_AT:RESET_AT};
})();
if (typeof module !== 'undefined') module.exports = RLSim;
