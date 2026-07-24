// bench/lib/yaml.js — the YAML-subset parser + frontmatter splitter.
//
// Vendored from throughline's lib/parse.js so the bench has zero imports from
// the host repo and can be split out as standalone software (tl's copy stays
// canonical for tl; this one is canonical for the bench). It handles the
// shapes bench notebooks actually use — nested maps, block lists, inline
// arrays, scalars, and `#` comments — not general YAML. Multi-line strings
// are handled one layer up (bench/lib/notebook.js lifts `key: |` block
// scalars out before this parser runs). Node stdlib only; zero dependencies.

'use strict';

// Drop a trailing `#` comment, respecting quotes so `title: "a # b"` survives.
// Escape-aware inside double quotes: a backslash consumes the next character
// (mirroring unescapeDouble's scan), so `\"` never toggles quote state and
// `label: "say \"one # two\""` keeps its tail. Single-quoted strings have no
// backslash escapes in this subset, so the skip applies only inside `"`.
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inD && c === '\\') { i++; continue; }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  // Double-quoted scalars unescape what the serializer escapes (bench/lib/
  // notebook.js yamlScalar: \\, \", \n) — one left-to-right scan so \\" reads
  // as an escaped backslash followed by the closing quote, never as \ + ".
  // Unknown escapes pass through untouched; single-quoted scalars stay
  // verbatim (the serializer never emits them, so there is nothing to invert).
  if (s[0] === '"' && s.endsWith('"')) return unescapeDouble(s.slice(1, -1));
  if (s[0] === "'" && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map(parseScalar);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// Split an inline array's interior on top-level commas only: a comma inside a
// quoted segment is content (`["a, b"]` is one item). Inside double quotes a
// backslash consumes the next character — the same scan discipline as
// stripComment and unescapeDouble, so `"say \"x, y\""` neither splits nor ends
// early and the quoted pieces hand off to parseScalar → unescapeDouble intact.
function splitInline(inner) {
  const parts = [];
  let cur = '', inS = false, inD = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inD && c === '\\' && i + 1 < inner.length) { cur += c + inner[++i]; continue; }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ',' && !inS && !inD) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// The inverse of yamlScalar's escaping, applied to a double-quoted scalar's
// interior. Left-to-right: a backslash consumes the next character, so the
// pairs resolve in one pass ("\\\"" is backslash-then-quote, not quote-quote).
function unescapeDouble(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\' || i + 1 >= inner.length) { out += inner[i]; continue; }
    const c = inner[++i];
    if (c === '"' || c === '\\') out += c;
    else if (c === 'n') out += '\n';
    else out += '\\' + c; // not an escape yamlScalar emits — keep it literal
  }
  return out;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    lines.push({ indent: line.match(/^ */)[0].length, content: line.trim() });
  }
  function parseBlock(idx) {
    if (idx >= lines.length) return [null, idx];
    if (lines[idx].content.startsWith('- ') || lines[idx].content === '-') {
      return parseList(idx, lines[idx].indent);
    }
    return parseMap(idx, lines[idx].indent);
  }
  function parseList(idx, indent) {
    const out = [];
    while (idx < lines.length && lines[idx].indent === indent && (lines[idx].content.startsWith('- ') || lines[idx].content === '-')) {
      const rest = lines[idx].content.replace(/^-\s*/, '');
      const kv = rest.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
      if (kv) {
        const obj = {};
        idx++;
        if (kv[2] !== undefined && kv[2] !== '') obj[kv[1]] = parseScalar(kv[2]);
        else if (idx < lines.length && lines[idx].indent > indent) {
          const [v, ni] = parseBlock(idx);
          obj[kv[1]] = v; idx = ni;
        } else obj[kv[1]] = null;
        while (idx < lines.length && lines[idx].indent > indent && !lines[idx].content.startsWith('- ')) {
          const m = lines[idx].content.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
          if (!m) break;
          const childIndent = lines[idx].indent;
          if (m[2] !== undefined && m[2] !== '') { obj[m[1]] = parseScalar(m[2]); idx++; }
          else {
            idx++;
            if (idx < lines.length && lines[idx].indent > childIndent) {
              const [v, ni] = parseBlock(idx);
              obj[m[1]] = v; idx = ni;
            } else obj[m[1]] = null;
          }
        }
        out.push(obj);
      } else {
        out.push(parseScalar(rest));
        idx++;
      }
    }
    return [out, idx];
  }
  function parseMap(idx, indent) {
    const obj = {};
    while (idx < lines.length && lines[idx].indent === indent && !lines[idx].content.startsWith('- ')) {
      const m = lines[idx].content.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
      if (!m) { idx++; continue; }
      if (m[2] !== undefined && m[2] !== '') { obj[m[1]] = parseScalar(m[2]); idx++; }
      else {
        idx++;
        if (idx < lines.length && lines[idx].indent > indent) {
          const [v, ni] = parseBlock(idx);
          obj[m[1]] = v; idx = ni;
        } else obj[m[1]] = null;
      }
    }
    return [obj, idx];
  }
  return parseBlock(0)[0];
}

// Split the leading `--- … ---` frontmatter block from the markdown body.
// Returns { meta, body }; a malformed/absent block yields empty meta and the
// whole text as body (never throws — a bad record degrades, it doesn't crash).
function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  let meta;
  try { meta = parseYaml(m[1]) || {}; } catch { meta = {}; }
  return { meta, body: m[2] };
}

module.exports = { stripComment, parseScalar, parseYaml, parseFrontmatter };
