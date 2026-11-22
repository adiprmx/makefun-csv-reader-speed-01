// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program, MIT, derived from
// d3-dsv 3.0.2 and papaparse 5.7.1). run(input) returns exactly what csv-reader's readCsv
// returns for the same input: {columns, rows, errors}. Written from scratch in this session.
//
// Policy (identical to csv-reader 1.0.0, see its index.js):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, each CRLF or lone CR inside it read as LF; what follows its closing quote,
//     up to the next comma or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text after it is read
//     again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it, each padded with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header).
//
// Speed: the reference walks one character at a time and concatenates every character. This
// parser instead works in slices: a whole record whose line holds no quote and no CR is
// split natively in one go (the overwhelmingly common case), and every other field is read
// by jumping from one special character to the next with indexOf, appending slices instead
// of single characters. No regex, no per-character loop, no allocation per character.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns the field and how it ended; `added`
  // counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      // The next terminator, comma or line break, whichever comes first.
      let next = -1;
      let isComma = false;
      if (comma !== -1 && (lf === -1 || comma < lf)) { next = comma; isComma = true; }
      else if (lf !== -1) { next = lf; }
      const cr = text.indexOf('\r', pos);
      if (cr !== -1 && (next === -1 || cr < next)) {
        // A CR comes before any comma or line break.
        if (cr > pos) { value += text.slice(pos, cr); added += cr - pos; }
        if (text.charCodeAt(cr + 1) === 10) {
          pos = cr + 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        error('stray_cr');
        pos = cr + 1;
        continue;
      }
      if (next === -1) {
        if (pos < n) { value += text.slice(pos, n); added += n - pos; }
        pos = n;
        return { value, ended: END, added };
      }
      if (next > pos) { value += text.slice(pos, next); added += next - pos; }
      if (isComma) {
        pos = next + 1;
        return { value, ended: COMMA, added };
      }
      pos = next + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const dq = text.indexOf('"', pos);
      const cr = text.indexOf('\r', pos);
      const lf = text.indexOf('\n', pos);
      // The next special character, whichever comes first.
      let next = -1;
      let kind = 0; // 0: quote, 1: CR, 2: LF
      if (dq !== -1) { next = dq; kind = 0; }
      if (cr !== -1 && (next === -1 || cr < next)) { next = cr; kind = 1; }
      if (lf !== -1 && (next === -1 || lf < next)) { next = lf; kind = 2; }
      if (next === -1) {
        value += text.slice(pos, n);
        pos = n;
        break;
      }
      if (kind === 2) {
        // LF inside quotes is kept as LF; only the line count moves.
        value += text.slice(pos, next + 1);
        line += 1;
        pos = next + 1;
        continue;
      }
      if (kind === 1) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += text.slice(pos, next);
        value += '\n';
        line += 1;
        pos = next + (text.charCodeAt(next + 1) === 10 ? 2 : 1);
        continue;
      }
      // A quote.
      value += text.slice(pos, next);
      if (text.charCodeAt(next + 1) === 34) {
        value += '"';
        pos = next + 2;
        continue;
      }
      pos = next + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Finishes one record: header, padding/cutting to the first record's width.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the whole record is on this line and the line holds no quote and no CR
    // outside a CRLF terminator, so no field can be quoted and no CR can hide. Split it
    // natively in one go. The quote/CR test runs on the sliced line itself, so no search
    // ever runs past the line (an unbounded indexOf from here would re-scan the same
    // stretch on every line). A trailing CR that is the CR of the line's CRLF is stripped
    // before splitting; any other CR falls through to the slow path.
    const lineEnd = text.indexOf('\n', pos);
    const segEnd = lineEnd === -1 ? n : lineEnd;
    const seg = text.slice(pos, segEnd);
    const crAt = seg.indexOf('\r');
    const crlf = crAt === seg.length - 1 && lineEnd !== -1;
    if (seg.indexOf('"') === -1 && (crAt === -1 || crlf)) {
      const fields = (crlf ? seg.slice(0, -1) : seg).split(',');
      pos = lineEnd === -1 ? n : lineEnd + 1;
      line += 1;
      finishRecord(fields);
      continue;
    }

    // Slow path: field by field, exactly as the reference reads them.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
