/**
 * Converts HTML to Slack Markdown format
 * Uses regular expressions instead of DOM manipulation for Node.js environments
 * @param html The HTML string to convert
 * @return The converted Slack Markdown string
 */
export function htmlToSlackMarkdown(html: string): string {
  // Basic tag replacements
  let markdown = html.trim();

  // Handle paragraphs
  markdown = markdown.replace(/<p>(.*?)<\/p>/gs, "$1\n\n");

  // Handle line breaks
  markdown = markdown.replace(/<br\s*\/?>/gi, "\n");

  // Handle bold text
  markdown = markdown.replace(/<(strong|b)>(.*?)<\/(strong|b)>/gs, "*$2*");

  // Handle italic text
  markdown = markdown.replace(/<(em|i)>(.*?)<\/(em|i)>/gs, "_$2_");

  // Handle code blocks
  markdown = markdown.replace(/<code>(.*?)<\/code>/gs, "`$1`");

  // Handle preformatted text
  markdown = markdown.replace(/<pre>(.*?)<\/pre>/gs, "```\n$1\n```\n");

  // Handle blockquotes
  markdown = markdown.replace(
    /<blockquote>(.*?)<\/blockquote>/gs,
    (_match, content: string) => {
      return (
        content
          .split("\n")
          .map((line: string) => "> " + line)
          .join("\n") + "\n"
      );
    },
  );

  // Handle unordered lists
  markdown = markdown.replace(/<ul>(.*?)<\/ul>/gs, "$1\n");

  // Handle ordered lists
  markdown = markdown.replace(/<ol>(.*?)<\/ol>/gs, "$1\n");

  // Handle list items
  // We need to track if we're in an ordered list and what number to use
  let listItemCounter = 0;
  let inOrderedList = false;

  markdown = markdown.replace(
    /<(ul|ol|li)(?:\s[^>]*)?>|<\/(ul|ol|li)>/gs,
    (match) => {
      if (match.startsWith("</ul>") || match.startsWith("</ol>")) {
        inOrderedList = false;
        listItemCounter = 0;
        return "";
      } else if (match.startsWith("<ul")) {
        inOrderedList = false;
        return "";
      } else if (match.startsWith("<ol")) {
        inOrderedList = true;
        listItemCounter = 0;
        return "";
      } else if (match.startsWith("<li")) {
        if (inOrderedList) {
          listItemCounter++;
          return `${listItemCounter}. `;
        } else {
          return "• ";
        }
      } else if (match.startsWith("</li>")) {
        return "\n";
      }
      return "";
    },
  );

  // Handle links
  markdown = markdown.replace(
    /<a\s+(?:[^>]*?\s+)?href="([^"]*)"(?:\s+[^>]*)?>(.*?)<\/a>/gs,
    (_match, href, text) => {
      return `<${href}|${text}>`;
    },
  );

  // Handle headings (h1-h6)
  markdown = markdown.replace(/<h[1-6]>(.*?)<\/h[1-6]>/gs, "*$1*\n\n");

  // Handle horizontal rules
  markdown = markdown.replace(/<hr\s*\/?>/gi, "---\n");

  // Remove all image tags
  markdown = markdown.replace(/<img\s+[^>]*>/g, "");

  // Clean up any remaining HTML tags
  markdown = markdown.replace(/<[^>]+>/g, "");

  // Fix multiple line breaks
  markdown = markdown.replace(/\n{3,}/g, "\n\n");

  return markdown;
}
