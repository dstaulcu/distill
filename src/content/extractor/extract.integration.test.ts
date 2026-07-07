import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extract } from "./extract";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDocument(html: string, url = "https://example.com/article"): Document {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

// ---------------------------------------------------------------------------
// Integration Tests: Content Extraction End-to-End
// ---------------------------------------------------------------------------

describe("CF-1 Content Extraction Integration", () => {
  describe("Heuristic detection via @mozilla/readability (Requirement 3.2)", () => {
    it("extracts a realistic blog post with article structure", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Understanding TypeScript Generics - Dev Blog</title>
            <meta property="og:title" content="Understanding TypeScript Generics" />
            <meta property="og:site_name" content="Dev Blog" />
            <meta name="author" content="Alice Johnson" />
            <meta property="article:published_time" content="2024-03-15T10:00:00Z" />
          </head>
          <body>
            <header>
              <nav><a href="/">Home</a> | <a href="/blog">Blog</a></nav>
            </header>
            <main>
              <article>
                <h1>Understanding TypeScript Generics</h1>
                <p class="byline">By Alice Johnson · March 15, 2024</p>
                <p>TypeScript generics provide a way to create reusable components that work with a variety of types rather than a single one. This gives users the power to create flexible, type-safe abstractions.</p>
                <h2>Basic Generic Functions</h2>
                <p>The simplest example of a generic function is the identity function. It takes an argument of any type and returns the same type back.</p>
                <pre><code class="language-typescript">function identity&lt;T&gt;(arg: T): T {
  return arg;
}</code></pre>
                <p>This function uses a type variable T that captures the type the user provides. We can then use that type as the return type.</p>
                <h2>Generic Constraints</h2>
                <p>Sometimes you want to constrain what types can be used with a generic. You can do this with the extends keyword to limit the types that a type parameter can accept.</p>
                <pre><code class="language-typescript">interface Lengthwise {
  length: number;
}

function loggingIdentity&lt;T extends Lengthwise&gt;(arg: T): T {
  console.log(arg.length);
  return arg;
}</code></pre>
                <h2>Generic Classes</h2>
                <p>Generic classes have a similar shape to generic interfaces. They have a generic type parameter list in angle brackets following the name of the class.</p>
                <p>A generic class ensures that all properties of the class are working with the same type. This is particularly useful for data structures like stacks, queues, and linked lists.</p>
                <h2>Conclusion</h2>
                <p>Generics are one of the most powerful features of TypeScript. They allow you to write flexible, reusable code while maintaining full type safety. Understanding generics is essential for writing idiomatic TypeScript.</p>
              </article>
            </main>
            <aside>
              <h3>Related Posts</h3>
              <ul><li><a href="/post/1">Post 1</a></li></ul>
            </aside>
            <footer><p>&copy; 2024 Dev Blog</p></footer>
          </body>
        </html>
      `;

      const doc = createDocument(html, "https://devblog.example.com/posts/typescript-generics");
      const result = await extract({ doc, url: "https://devblog.example.com/posts/typescript-generics" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify article content was extracted
      expect(result.article.bodyMarkdown).toContain("Generic Constraints");
      expect(result.article.bodyMarkdown).toContain("TypeScript generics provide");
      expect(result.article.bodyCharacterCount).toBeGreaterThan(200);

      // Verify metadata extraction
      expect(result.article.title).toBe("Understanding TypeScript Generics");
      expect(result.article.author).toBe("Alice Johnson");
      expect(result.article.publicationDate).toBe("2024-03-15T10:00:00Z");
      expect(result.article.siteName).toBe("Dev Blog");
      expect(result.article.sourceUrl).toBe("https://devblog.example.com/posts/typescript-generics");

      // Verify confidence is high (content > 500 chars)
      expect(result.confidence).toBe("high");

      // Verify navigation/footer content is NOT in the extracted markdown
      expect(result.article.bodyMarkdown).not.toContain("Related Posts");
    });

    it("extracts a news article with JSON-LD metadata", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Breaking: New Discovery in Space - Science Daily</title>
            <script type="application/ld+json">
            {
              "@type": "NewsArticle",
              "headline": "New Discovery in Space",
              "author": { "name": "Dr. Sarah Chen" },
              "datePublished": "2024-06-01T08:30:00Z",
              "publisher": { "name": "Science Daily" }
            }
            </script>
          </head>
          <body>
            <nav><a href="/">Science Daily</a></nav>
            <article>
              <h1>New Discovery in Space</h1>
              <p>Scientists have made a groundbreaking discovery that could change our understanding of the universe. The team at the International Space Observatory detected unusual signals from a distant galaxy cluster.</p>
              <p>The signals, first noticed in January, have been confirmed by multiple independent observatories around the world. Researchers believe these could be evidence of a previously unknown phenomenon.</p>
              <p>"This is unlike anything we've seen before," said lead researcher Dr. Sarah Chen. "The patterns suggest a complex interaction between dark matter and regular matter that our current models don't account for."</p>
              <p>The discovery was made using the new generation of radio telescopes that became operational last year. These instruments are capable of detecting signals that were previously too faint to observe.</p>
              <p>Further analysis is expected to take several months, with preliminary results to be published in the journal Nature by the end of the year.</p>
            </article>
            <footer><p>Copyright Science Daily 2024</p></footer>
          </body>
        </html>
      `;

      const doc = createDocument(html, "https://sciencedaily.example.com/news/space-discovery");
      const result = await extract({ doc, url: "https://sciencedaily.example.com/news/space-discovery" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify content extraction
      expect(result.article.bodyMarkdown).toContain("groundbreaking discovery");
      expect(result.article.bodyMarkdown).toContain("radio telescopes");

      // Verify JSON-LD metadata was used
      expect(result.article.title).toBe("New Discovery in Space");
      expect(result.article.author).toBe("Dr. Sarah Chen");
      expect(result.article.publicationDate).toBe("2024-06-01T08:30:00Z");
      expect(result.article.siteName).toBe("Science Daily");
    });

    it("produces Markdown with proper heading hierarchy", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Guide to Testing</title></head>
          <body>
            <article>
              <h1>Guide to Testing</h1>
              <p>Testing is essential for software quality. This guide covers the fundamentals of testing in modern applications and provides practical examples.</p>
              <h2>Unit Tests</h2>
              <p>Unit tests verify individual functions work correctly in isolation. They are fast and provide immediate feedback during development.</p>
              <h3>Writing Good Unit Tests</h3>
              <p>Good unit tests are focused, independent, and deterministic. Each test should verify one specific behavior and should not depend on other tests.</p>
              <h2>Integration Tests</h2>
              <p>Integration tests verify that multiple components work together correctly. They test the boundaries between modules and catch issues that unit tests miss.</p>
            </article>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({ doc, url: "https://example.com/guide" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify heading hierarchy in Markdown
      // Note: Readability strips the h1 (it becomes the article title), so body starts at h2
      expect(result.article.bodyMarkdown).toContain("## Unit Tests");
      expect(result.article.bodyMarkdown).toContain("### Writing Good Unit Tests");
      expect(result.article.bodyMarkdown).toContain("## Integration Tests");
    });

    it("returns failure for a page with no meaningful content", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Login</title></head>
          <body>
            <form>
              <input type="text" placeholder="Username" />
              <input type="password" placeholder="Password" />
              <button type="submit">Login</button>
            </form>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({ doc, url: "https://example.com/login" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-content-detected");
      }
    });
  });

  describe("Selector-based extraction (Requirement 3.1)", () => {
    it("extracts content using a CSS selector, bypassing Readability", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>My Blog Post</title>
            <meta property="og:title" content="My Blog Post" />
            <meta name="author" content="Bob Smith" />
          </head>
          <body>
            <header><h1>Site Header</h1></header>
            <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
            <div class="sidebar">
              <h3>Popular Posts</h3>
              <ul><li>Post A</li><li>Post B</li></ul>
            </div>
            <div id="post-content" class="article-body">
              <h2>Introduction to Rust</h2>
              <p>Rust is a systems programming language that runs blazingly fast, prevents segfaults, and guarantees thread safety. It accomplishes these goals by being memory safe without using garbage collection.</p>
              <h3>Ownership Model</h3>
              <p>Rust's central feature is ownership. All programs have to manage the way they use a computer's memory while running. Rust uses a system of ownership with a set of rules that the compiler checks at compile time.</p>
              <h3>Borrowing</h3>
              <p>References allow you to refer to some value without taking ownership of it. This is called borrowing. Just as in real life, if a person owns something, you can borrow it from them.</p>
            </div>
            <footer><p>Copyright 2024</p></footer>
          </body>
        </html>
      `;

      const doc = createDocument(html, "https://blog.example.com/rust-intro");
      const result = await extract({
        doc,
        url: "https://blog.example.com/rust-intro",
        contentSelector: "#post-content",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify only the selected content is extracted
      expect(result.article.bodyMarkdown).toContain("Introduction to Rust");
      expect(result.article.bodyMarkdown).toContain("Ownership Model");
      expect(result.article.bodyMarkdown).toContain("Borrowing");

      // Verify non-selected content is excluded
      expect(result.article.bodyMarkdown).not.toContain("Site Header");
      expect(result.article.bodyMarkdown).not.toContain("Popular Posts");
      expect(result.article.bodyMarkdown).not.toContain("Copyright 2024");

      // Selector-based extraction always returns high confidence
      expect(result.confidence).toBe("high");

      // Metadata is still extracted from the full document
      expect(result.article.title).toBe("My Blog Post");
      expect(result.article.author).toBe("Bob Smith");

      // No stale pattern flag
      expect(result.stalePattern).toBeUndefined();
    });

    it("extracts content using a class-based selector", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Tech Article</title></head>
          <body>
            <div class="page-wrapper">
              <div class="ad-banner">Buy our product!</div>
              <div class="main-content">
                <h1>Understanding Async/Await</h1>
                <p>Async/await is syntactic sugar built on top of promises. It makes asynchronous code look and behave more like synchronous code, which makes it easier to understand and debug.</p>
                <p>The async keyword is used to declare an async function. When called, an async function returns a Promise. When the async function returns a value, the Promise will be resolved with the returned value.</p>
              </div>
              <div class="comments-section">User comments here</div>
            </div>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/async-await",
        contentSelector: ".main-content",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.article.bodyMarkdown).toContain("Async/Await");
      expect(result.article.bodyMarkdown).not.toContain("Buy our product");
      expect(result.article.bodyMarkdown).not.toContain("User comments here");
    });
  });

  describe("Fallback on stale selector (Requirement 3.8)", () => {
    it("falls back to Readability when selector matches nothing and flags stalePattern", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Updated Blog Design</title>
            <meta property="og:title" content="Updated Blog Design" />
          </head>
          <body>
            <article>
              <h1>Updated Blog Design</h1>
              <p>We've completely redesigned our blog. The new layout features a cleaner reading experience with better typography and improved navigation. We hope you enjoy the new look and feel.</p>
              <p>The redesign took several months of work and involved user research, prototyping, and extensive testing. We gathered feedback from hundreds of readers to inform our design decisions.</p>
              <p>Key improvements include faster page loads, better mobile responsiveness, and improved accessibility. We've also added a dark mode option for comfortable reading at night.</p>
            </article>
          </body>
        </html>
      `;

      const doc = createDocument(html, "https://blog.example.com/redesign");

      // Use a selector that no longer exists (site was redesigned)
      const result = await extract({
        doc,
        url: "https://blog.example.com/redesign",
        contentSelector: "#old-content-wrapper",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Content should still be extracted via Readability fallback
      expect(result.article.bodyMarkdown).toContain("redesigned our blog");
      expect(result.article.bodyMarkdown).toContain("Key improvements");
      expect(result.article.bodyCharacterCount).toBeGreaterThan(0);

      // Pattern should be flagged as stale
      expect(result.stalePattern).toBe(true);

      // Metadata should still be extracted
      expect(result.article.title).toBe("Updated Blog Design");
    });

    it("returns failure when stale selector AND Readability both fail", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Empty Page</title></head>
          <body>
            <script>console.log("no content");</script>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/empty",
        contentSelector: ".removed-element",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-content-detected");
        expect(result.detail).toContain("selector");
      }
    });

    it("uses Readability confidence level when falling back from stale selector", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Long Article</title></head>
          <body>
            <article>
              <h1>Long Article</h1>
              <p>${"This is a substantial paragraph of content that demonstrates high confidence extraction. ".repeat(20)}</p>
            </article>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({
        doc,
        url: "https://example.com/long-article",
        contentSelector: ".nonexistent-selector",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should have high confidence from Readability (content > 500 chars)
      expect(result.confidence).toBe("high");
      expect(result.stalePattern).toBe(true);
    });
  });

  describe("End-to-end pipeline verification", () => {
    it("produces a complete ExtractedArticle with all fields populated", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Complete Article - Example Site</title>
            <meta property="og:title" content="Complete Article" />
            <meta property="og:site_name" content="Example Site" />
            <meta name="author" content="Jane Developer" />
            <meta property="article:published_time" content="2024-01-20T14:30:00Z" />
            <link rel="canonical" href="https://example.com/complete-article" />
          </head>
          <body>
            <article>
              <h1>Complete Article</h1>
              <p>This article demonstrates the full extraction pipeline working end-to-end. It includes various HTML elements that should be properly converted to Markdown format.</p>
              <h2>Lists</h2>
              <ul>
                <li>First item</li>
                <li>Second item</li>
                <li>Third item</li>
              </ul>
              <h2>Code Example</h2>
              <pre><code class="language-javascript">const greeting = "Hello, World!";
console.log(greeting);</code></pre>
              <h2>Links and Emphasis</h2>
              <p>Visit <a href="https://example.com">our site</a> for more <strong>important</strong> information about <em>various topics</em>.</p>
            </article>
          </body>
        </html>
      `;

      const doc = createDocument(html, "https://example.com/complete-article");
      const result = await extract({ doc, url: "https://example.com/complete-article" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // All metadata fields populated
      expect(result.article.title).toBe("Complete Article");
      expect(result.article.author).toBe("Jane Developer");
      expect(result.article.publicationDate).toBe("2024-01-20T14:30:00Z");
      expect(result.article.sourceUrl).toBe("https://example.com/complete-article");
      expect(result.article.siteName).toBe("Example Site");

      // Body markdown contains converted elements
      expect(result.article.bodyMarkdown).toContain("First item");
      expect(result.article.bodyMarkdown).toContain("Second item");
      expect(result.article.bodyMarkdown).toContain("[our site]");
      expect(result.article.bodyCharacterCount).toBeGreaterThan(0);

      // Confidence is set
      expect(["high", "medium", "low"]).toContain(result.confidence);
    });

    it("handles a page with tables via GFM plugin", async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Data Report</title></head>
          <body>
            <article>
              <h1>Quarterly Data Report</h1>
              <p>Below is the summary of our quarterly performance metrics across all departments.</p>
              <table>
                <thead>
                  <tr><th>Quarter</th><th>Revenue</th><th>Growth</th></tr>
                </thead>
                <tbody>
                  <tr><td>Q1</td><td>$1.2M</td><td>15%</td></tr>
                  <tr><td>Q2</td><td>$1.5M</td><td>25%</td></tr>
                  <tr><td>Q3</td><td>$1.8M</td><td>20%</td></tr>
                </tbody>
              </table>
              <p>The results show consistent growth across all quarters with strong performance in Q2.</p>
            </article>
          </body>
        </html>
      `;

      const doc = createDocument(html);
      const result = await extract({ doc, url: "https://example.com/report" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Table should be rendered as Markdown table
      expect(result.article.bodyMarkdown).toContain("Quarter");
      expect(result.article.bodyMarkdown).toContain("Revenue");
      expect(result.article.bodyMarkdown).toContain("|");
    });

    it("handles error gracefully when extraction throws", async () => {
      const badDoc = {
        URL: "https://example.com",
        querySelector: () => { throw new TypeError("Cannot read properties of null"); },
        cloneNode: () => { throw new TypeError("Cannot read properties of null"); },
      } as unknown as Document;

      const result = await extract({
        doc: badDoc,
        url: "https://example.com/broken",
        contentSelector: ".content",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("extraction-error");
        expect(result.detail.length).toBeLessThanOrEqual(200);
      }
    });
  });
});
