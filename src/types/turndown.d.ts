declare module "turndown" {
  interface Options {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
    fence?: "```" | "~~~";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
    linkStyle?: "inlined" | "referenced";
    linkReferenceStyle?: "full" | "collapsed" | "shortcut";
    blankReplacement?: (content: string, node: Node) => string;
    keepReplacement?: (content: string, node: Node) => string;
    defaultReplacement?: (content: string, node: Node) => string;
  }

  interface Rule {
    filter: string | string[] | ((node: HTMLElement, options: Options) => boolean);
    replacement: (content: string, node: HTMLElement, options: Options) => string;
  }

  class TurndownService {
    constructor(options?: Options);
    turndown(html: string | HTMLElement): string;
    use(plugin: (service: TurndownService) => void): TurndownService;
    addRule(key: string, rule: Rule): TurndownService;
    keep(filter: string | string[] | ((node: HTMLElement) => boolean)): TurndownService;
    remove(filter: string | string[] | ((node: HTMLElement) => boolean)): TurndownService;
    escape(str: string): string;
  }

  export default TurndownService;
}

declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown";

  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
