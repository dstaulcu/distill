/**
 * Simple markdown-to-HTML renderer for chat messages (CF-3.5).
 * Handles: bold, italic, headings, bullet lists, code blocks, inline code, links.
 *
 * The output is injected via innerHTML into the privileged sidebar document,
 * and the input (AI responses, page-derived text) is untrusted — so escaping
 * and link-scheme filtering here are a security boundary, not cosmetics.
 */
export function renderMarkdown(text: string): string {
  // Escape HTML first — including quotes, so untrusted text can never break
  // out of an attribute value (CF-3.5)
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings (## ... )
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Unordered lists (lines starting with * or - or +)
  // Collapse blank lines between consecutive bullets first — LLM output
  // commonly separates list items with a blank line, and without this the
  // list-grouping step below would split them into one <ul> per item.
  html = html.replace(/^([\*\-\+] .+)\n+(?=[\*\-\+] )/gm, '$1\n');
  html = html.replace(/^[\*\-\+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // The newlines that separated bullet lines are still sitting inside the
  // <ul>; left alone they'd later become stray <br> tags between items.
  html = html.replace(/<ul>[\s\S]*?<\/ul>/g, (match) => match.replace(/\n/g, ''));

  // Links [text](url) — only http(s) schemes become anchors; anything else
  // (javascript:, data:, etc.) stays as plain escaped text (CF-3.5)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      return match;
    }
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[234]>)/g, '$1');
  html = html.replace(/(<\/h[234]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');

  // Single newlines → <br> (within paragraphs)
  html = html.replace(/\n/g, '<br>');

  return html;
}
