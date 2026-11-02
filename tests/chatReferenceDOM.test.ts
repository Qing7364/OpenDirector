import assert from "node:assert/strict";
import test from "node:test";
import { readDOM } from "../src/canvas/chatReferenceDOM.ts";

test("a browser's lone empty line is empty content, while real line breaks remain", () => {
  const previousElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  class Element {
    dataset = {};
    nodeType = 1;
    nodeName: string;
    childNodes: object[];
    constructor(nodeName: string, childNodes: object[] = []) {
      this.nodeName = nodeName;
      this.childNodes = childNodes;
    }
    get firstChild() {
      return this.childNodes[0];
    }
  }
  globalThis.HTMLElement = Element as unknown as typeof HTMLElement;
  globalThis.Node = { TEXT_NODE: 3 } as typeof Node;
  const br = new Element("BR");
  const text = (textContent: string) => ({ nodeType: 3, nodeName: "#text", textContent });
  try {
    assert.deepEqual(readDOM(new Element("DIV", [br]) as unknown as HTMLElement), []);
    assert.deepEqual(
      readDOM(new Element("DIV", [text("first"), br, text("second")]) as unknown as HTMLElement),
      [{ type: "text", text: "first\nsecond" }],
    );
  } finally {
    globalThis.HTMLElement = previousElement;
    globalThis.Node = previousNode;
  }
});
