import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { costOf } from './pricing.js';

/** Klasor adi -> gercek yol. "C--Users-hasan-Desktop-x" seklinde kodlanmis. */
export function decodeProjectDir(name) {
  const m = name.match(/^([A-Za-z])--(.*)$/);
  if (!m) return name;
  const SEP = String.fromCharCode(92); // ters bolu
  return m[1] + ':' + SEP + m[2].split('-').join(SEP);
}

const ts = (d) => (d?.timestamp ? Date.parse(d.timestamp) : null);

/** Gercek kullanici promptu mu? Arac sonucu / meta / sistem enjeksiyonu degil. */
function isHumanPrompt(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return false;
  const c = d.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) return c.some((b) => b?.type === 'text');
  return false;
}

function promptText(d) {
  const c = d.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
  return '';
}

export async function parseSession(file, projectDirName) {
  const s = {
    sessionId: basename(file, '.jsonl'),
    file,
    project: projectDirName,
    projectPath: decodeProjectDir(projectDirName),
    cwd: null,
    gitBranch: null,
    title: null,
    version: null,
    startedAt: null,
    endedAt: null,
    lastActivityAt: null,
    humanTurns: 0,
    assistantMsgs: 0,
    sidechainMsgs: 0,
    toolCalls: 0,
    errorResults: 0,
    lines: 0,
    activeMs: 0,
    firstPrompt: null,
    models: new Map(),   // model -> {msgs, in, out, cacheW, cacheR, usd}
    tools: new Map(),    // tool  -> adet
    usd: 0,
    unknownCost: false,
  };

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  // Iki olay arasi bu esikten uzunsa "mola" sayilir, aktif sureye eklenmez.
  const MOLA_MS = 5 * 60 * 1000;
  let prevTs = null;

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let d;
    try { d = JSON.parse(t); } catch { continue; }
    s.lines++;

    const at = ts(d);
    if (at) {
      if (s.startedAt == null || at < s.startedAt) s.startedAt = at;
      if (s.endedAt == null || at > s.endedAt) s.endedAt = at;
      if (prevTs != null) {
        const d = at - prevTs;
        if (d > 0 && d <= MOLA_MS) s.activeMs += d;
      }
      prevTs = at;
    }
    if (d.cwd) s.cwd = d.cwd;
    if (d.gitBranch) s.gitBranch = d.gitBranch;
    if (d.version) s.version = d.version;
    if (d.type === 'custom-title' && d.customTitle) s.title = d.customTitle;
    else if (d.type === 'ai-title' && !s.title && d.title) s.title = d.title;

    if (d.isSidechain) s.sidechainMsgs++;

    if (isHumanPrompt(d)) {
      s.humanTurns++;
      if (!s.firstPrompt) s.firstPrompt = promptText(d).slice(0, 300);
    }

    // Arac hatalarini yakala (takilma noktalarini bulmak icin)
    if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === 'tool_result' && b.is_error) s.errorResults++;
      }
    }

    if (d.type !== 'assistant') continue;
    s.assistantMsgs++;
    const m = d.message || {};
    const model = m.model || 'bilinmiyor';

    for (const b of m.content || []) {
      if (b?.type === 'tool_use') {
        s.toolCalls++;
        s.tools.set(b.name, (s.tools.get(b.name) || 0) + 1);
      }
    }

    const u = m.usage;
    if (!u) continue;
    const { usd, unknown } = costOf(model, u, at);
    if (unknown) s.unknownCost = true;

    let e = s.models.get(model);
    if (!e) { e = { msgs: 0, in: 0, out: 0, cacheW: 0, cacheR: 0, usd: 0 }; s.models.set(model, e); }
    e.msgs++;
    e.in += u.input_tokens || 0;
    e.out += u.output_tokens || 0;
    e.cacheW += u.cache_creation_input_tokens || 0;
    e.cacheR += u.cache_read_input_tokens || 0;
    e.usd += usd;
    s.usd += usd;
  }

  s.lastActivityAt = s.endedAt;
  // Klasor adindaki kodlama kayipli (bosluk ve tire ayni karaktere dusuyor).
  // Kayitlarda gercek cwd varsa o kesin dogru, onu tercih et.
  if (s.cwd) s.projectPath = s.cwd;
  return s;
}

/** Alt-ajan (Task) kayitlarini ana oturumun toplamlarina katar. */
export function mergeSub(parent, sub) {
  parent.subSessions = (parent.subSessions || 0) + 1;
  parent.subMsgs = (parent.subMsgs || 0) + sub.assistantMsgs;
  parent.subUsd = (parent.subUsd || 0) + sub.usd;
  parent.assistantMsgs += sub.assistantMsgs;
  parent.toolCalls += sub.toolCalls;
  parent.errorResults += sub.errorResults;
  parent.usd += sub.usd;
  parent.lines += sub.lines;
  parent.activeMs += sub.activeMs;
  if (sub.unknownCost) parent.unknownCost = true;
  if (sub.endedAt && (!parent.endedAt || sub.endedAt > parent.endedAt)) parent.endedAt = sub.endedAt;

  for (const [model, e] of sub.models) {
    let t = parent.models.get(model);
    if (!t) { t = { msgs: 0, in: 0, out: 0, cacheW: 0, cacheR: 0, usd: 0 }; parent.models.set(model, t); }
    t.msgs += e.msgs; t.in += e.in; t.out += e.out;
    t.cacheW += e.cacheW; t.cacheR += e.cacheR; t.usd += e.usd;
  }
  for (const [tool, n] of sub.tools) parent.tools.set(tool, (parent.tools.get(tool) || 0) + n);
  return parent;
}
