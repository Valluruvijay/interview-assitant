(function (root) {
  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdownTable(rows) {
    if (!rows || rows.length === 0) return '';
    const isDelimiter = (str) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(str.trim());

    let headerCells = [];
    let alignments = [];
    let dataStartIndex = 1;

    if (rows.length > 1 && isDelimiter(rows[1])) {
      dataStartIndex = 2;
      const rawCols = rows[1].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      alignments = rawCols.map(col => {
        const c = col.trim();
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
    }

    const rawHeaders = rows[0].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    headerCells = rawHeaders.map(c => c.trim());

    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    headerCells.forEach((cell, idx) => {
      const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
      html += `<th${align}>${cell}</th>`;
    });
    html += '</tr></thead><tbody>';

    for (let r = dataStartIndex; r < rows.length; r++) {
      const rowStr = rows[r].trim();
      if (!rowStr) continue;
      if (isDelimiter(rowStr)) continue;
      const rawCells = rowStr.replace(/^\|/, '').replace(/\|$/, '').split('|');
      html += '<tr>';
      rawCells.forEach((cell, idx) => {
        const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
        html += `<td${align}>${cell.trim()}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderMarkdown(md) {
    if (!md) return '';

    const codeBlocks = [];
    let processed = md.replace(/```(?:([a-zA-Z0-9_+-]+)[ \t]*\r?\n)?([\s\S]*?)```/g, (match, lang, code) => {
      const cleanCode = String(code || '').replace(/^\r?\n+|\r?\n+$/g, '');
      const langTag = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span class="code-lang">code</span>';
      codeBlocks.push(
        `<div class="code-block-wrap">` +
        `<div class="code-block-header">${langTag}<button type="button" class="code-copy-btn" onclick="copyCodeBlock(this)" title="Copy code">📋 Copy</button></div>` +
        `<pre><code>${escapeHtml(cleanCode)}</code></pre>` +
        `</div>`
      );
      return '%%CODEBLOCK' + (codeBlocks.length - 1) + '%%';
    });

    processed = escapeHtml(processed);

    const lines = processed.split('\n');
    let html = '';
    let inList = false;
    let inCard = null; // 'teleprompter' | 'cheatsheet' | 'followup' | null
    let seenSectionHeader = false;
    let tableBuffer = [];

    function closeList() {
      if (inList) { html += '</ul>'; inList = false; }
    }

    function closeCard() {
      // Only teleprompter and followup open a wrapping card <div>; cheatsheet renders a standalone banner.
      if (inCard === 'teleprompter' || inCard === 'followup') { html += '</div>'; }
      inCard = null;
    }

    function ensureAutoTeleprompter() {
      // Wrap opening spoken prose/bullets in the teleprompter card even if the model omits `### 🗣️ Say This`.
      if (!seenSectionHeader && !inCard) {
        inCard = 'teleprompter';
        seenSectionHeader = true;
        html += '<div class="teleprompter-card"><div class="tp-title">🗣️ Say This (Speak Aloud)</div>';
      }
    }

    function flushTable() {
      if (tableBuffer.length > 0) {
        html += renderMarkdownTable(tableBuffer);
        tableBuffer = [];
      }
    }

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      line = line.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      line = line.replace(/`([^`]+)`/g, '<code>$1</code>');

      const trimmed = line.trim();
      if (/^#{1,4}$/.test(trimmed)) continue;

      if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
        closeList();
        if (inCard === 'teleprompter') closeCard();
        seenSectionHeader = true;
        tableBuffer.push(line);
        continue;
      } else {
        flushTable();
      }

      const cleanHeading = trimmed
        .replace(/^#{1,4}\s+/, '')
        .replace(/<\/?strong>/gi, '')
        .trim();
      const isExplicitHeading = /^#{2,4}\s+/.test(trimmed);
      const isSayThisHeading = /^🗣️/.test(cleanHeading) || /^(?:say this|quick talking points)(?:\s*\([^)]*\))?:?$/i.test(cleanHeading);
      const isCheatSheetHeading = /^📌/.test(cleanHeading) || /^cheat sheet(?:\s*\/\s*code)?(?:\s*\([^)]*\))?:?$/i.test(cleanHeading);
      const isFollowUpHeading = /^🔮/.test(cleanHeading) || /^anticipated follow-?ups?:?$/i.test(cleanHeading);

      if (trimmed === '---' || isExplicitHeading || isSayThisHeading || isCheatSheetHeading || isFollowUpHeading) {
        closeList();
        closeCard();
        seenSectionHeader = true;

        if (trimmed === '---') {
          html += '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;">';
          continue;
        }

        if (isSayThisHeading) {
          inCard = 'teleprompter';
          const displayTitle = /talking points/i.test(cleanHeading) ? '🗣️ Quick Talking Points (Say Aloud)' : '🗣️ Say This (Speak Aloud)';
          html += '<div class="teleprompter-card"><div class="tp-title">' + displayTitle + '</div>';
        } else if (isCheatSheetHeading) {
          inCard = 'cheatsheet';
          html += '<div style="font-weight:700;margin:10px 0 4px;color:#38bdf8;font-size:12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(56,189,248,0.25);padding-bottom:3px;"><span>📌</span> Cheat Sheet / Code</div>';
        } else if (isFollowUpHeading) {
          inCard = 'followup';
          html += '<div class="followup-card"><div class="fp-title">🔮 Anticipated Follow-Ups</div>';
        } else {
          html += '<div style="font-weight:700;margin:6px 0 3px;color:#1D9E75;font-size:13px;">' + cleanHeading + '</div>';
        }
      } else if (/^[-*•]\s/.test(trimmed)) {
        if (inCard === 'followup') {
          const rawQ = trimmed.replace(/^[-*•]\s*/, '').replace(/<[^>]+>/g, '').trim();
          const cleanQ = rawQ.replace(/→.*$/, '').trim();
          const encodedQ = encodeURIComponent(cleanQ);
          html += '<div class="followup-item"><span>' + trimmed + '</span> <button class="ask-pill" data-q="' + encodedQ + '" onclick="sendFollowUpFromPill(this)">⚡ Ask</button></div>';
        } else {
          ensureAutoTeleprompter();
          if (!inList) { html += '<ul style="margin:3px 0;padding-left:16px;">'; inList = true; }
          html += '<li style="margin:2px 0;">' + trimmed.replace(/^[-*•]\s+/, '') + '</li>';
        }
      } else if (/^\d+[\.\)]\s/.test(trimmed)) {
        closeList();
        if (inCard === 'followup') {
          const rawQ = trimmed.replace(/^\d+[\.\)]\s*/, '').replace(/<[^>]+>/g, '').trim();
          const cleanQ = rawQ.replace(/→.*$/, '').trim();
          const encodedQ = encodeURIComponent(cleanQ);
          html += '<div class="followup-item"><span>' + trimmed + '</span> <button class="ask-pill" data-q="' + encodedQ + '" onclick="sendFollowUpFromPill(this)">⚡ Ask</button></div>';
        } else {
          ensureAutoTeleprompter();
          html += '<div style="margin:2px 0;padding-left:4px;">' + trimmed + '</div>';
        }
      } else if (trimmed.startsWith('<pre>') || trimmed.startsWith('%%CODEBLOCK')) {
        closeList();
        if (inCard === 'teleprompter') closeCard();
        seenSectionHeader = true;
        html += line;
      } else if (trimmed === '') {
        closeList();
        html += '<div style="height:4px;"></div>';
      } else {
        closeList();
        ensureAutoTeleprompter();
        html += '<div style="margin:2px 0;">' + line + '</div>';
      }
    }
    flushTable();
    closeList();
    closeCard();

    codeBlocks.forEach((block, i) => {
      html = html.replace('%%CODEBLOCK' + i + '%%', () => block);
    });

    return html;
  }

  const exported = { escapeHtml, renderMarkdownTable, renderMarkdown };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (root) {
    root.escapeHtml = escapeHtml;
    root.renderMarkdownTable = renderMarkdownTable;
    root.renderMarkdown = renderMarkdown;
  }
})(typeof window !== 'undefined' ? window : globalThis);
