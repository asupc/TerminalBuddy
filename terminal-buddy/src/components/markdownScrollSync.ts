/*---------------------------------------------------------------------------------------------
 * Adapted from Visual Studio Code's Markdown preview scroll-sync implementation.
 * Copyright (c) Microsoft Corporation. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

const CODE_LINE_CLASS = 'code-line';

class CodeLineElement {
  readonly detailParents: HTMLDetailsElement[];

  constructor(
    readonly element: HTMLElement,
    readonly line: number,
    readonly codeElement?: HTMLElement,
    readonly endLine?: number,
  ) {
    this.detailParents = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') this.detailParents.push(parent as HTMLDetailsElement);
    }
  }

  get isVisible(): boolean {
    if (this.detailParents.some(parent => !parent.open)) return false;
    const style = window.getComputedStyle(this.element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const bounds = this.element.getBoundingClientRect();
    return bounds.height > 0 && bounds.width > 0;
  }
}

interface ElementBounds {
  top: number;
  height: number;
}

export class MarkdownScrollSync {
  readonly lines: CodeLineElement[];

  constructor(private readonly scrollContainer: HTMLElement) {
    this.lines = [new CodeLineElement(this.getMarkdownBody(), -1)];
    for (const element of this.scrollContainer.getElementsByClassName(CODE_LINE_CLASS)) {
      if (!(element instanceof HTMLElement)) continue;
      const line = Number(element.getAttribute('data-line'));
      if (Number.isNaN(line)) continue;

      if (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE') {
        const lineCount = (element.textContent?.match(/\n/g) ?? []).length + 1;
        this.lines.push(new CodeLineElement(
          element.parentElement,
          line,
          element,
          line + lineCount - 1,
        ));
      } else if (element.tagName !== 'PRE' && element.tagName !== 'UL' && element.tagName !== 'OL') {
        this.lines.push(new CodeLineElement(element, line));
      }
    }
  }

  scrollToRevealSourceLine(line: number): void {
    if (line <= 0) {
      this.scrollContainer.scrollTop = 0;
      return;
    }

    const { previous, next } = this.getElementsForSourceLine(line);
    const bounds = this.getElementBounds(previous);
    const previousAbsoluteTop = this.scrollContainer.scrollTop + bounds.top;
    let scrollTo: number;

    if (previous.endLine !== undefined && previous.endLine > previous.line) {
      if (line < previous.endLine) {
        const contentBounds = this.getContentBounds(previous);
        const progress = (line - previous.line) / (previous.endLine - previous.line);
        scrollTo = this.scrollContainer.scrollTop + contentBounds.top + contentBounds.height * progress;
      } else if (next && next.line !== previous.line) {
        const progress = (line - previous.endLine) / (next.line - previous.endLine);
        const previousAbsoluteEnd = previousAbsoluteTop + bounds.height;
        const nextAbsoluteTop = this.scrollContainer.scrollTop + this.getElementBounds(next).top;
        scrollTo = previousAbsoluteEnd + progress * (nextAbsoluteTop - previousAbsoluteEnd);
      } else {
        scrollTo = previousAbsoluteTop + bounds.height;
      }
    } else if (next && next.line !== previous.line) {
      const progress = (line - previous.line) / (next.line - previous.line);
      const previousAbsoluteEnd = previousAbsoluteTop + bounds.height;
      const nextAbsoluteTop = this.scrollContainer.scrollTop + this.getElementBounds(next).top;
      scrollTo = previousAbsoluteEnd + progress * (nextAbsoluteTop - previousAbsoluteEnd);
    } else {
      scrollTo = previousAbsoluteTop + bounds.height * (line - Math.floor(line));
    }

    this.scrollContainer.scrollTop = Math.max(1, scrollTo);
  }

  getEditorLineForScrollTop(): number | null {
    const { previous, next } = this.getLineElementsAtViewportTop();
    if (previous.line < 0) return 0;

    const previousBounds = this.getElementBounds(previous);
    const offsetFromPrevious = -previousBounds.top;

    if (previous.endLine !== undefined && previous.endLine > previous.line) {
      const contentBounds = this.getContentBounds(previous);
      const offsetFromContent = -contentBounds.top;
      if (offsetFromContent >= 0 && offsetFromContent <= contentBounds.height) {
        return previous.line
          + (offsetFromContent / contentBounds.height) * (previous.endLine - previous.line);
      }
      if (next && offsetFromContent > contentBounds.height) {
        const gapOffset = offsetFromContent - contentBounds.height;
        const nextBounds = this.getElementBounds(next);
        const contentEnd = contentBounds.top + contentBounds.height;
        const gapHeight = nextBounds.top - contentEnd;
        const progress = gapHeight > 0 ? gapOffset / gapHeight : 0;
        return previous.endLine + progress * (next.line - previous.endLine);
      }
    }

    if (next) {
      const distance = this.getElementBounds(next).top - previousBounds.top;
      const progress = distance > 0 ? offsetFromPrevious / distance : 0;
      return previous.line + progress * (next.line - previous.line);
    }
    const progress = previousBounds.height > 0 ? offsetFromPrevious / previousBounds.height : 0;
    return previous.line + progress;
  }

  private getMarkdownBody(): HTMLElement {
    return this.scrollContainer.querySelector<HTMLElement>('.markdown-preview-body') ?? this.scrollContainer;
  }

  private getElementsForSourceLine(targetLine: number): {
    previous: CodeLineElement;
    next?: CodeLineElement;
  } {
    const lineNumber = Math.floor(targetLine);
    let previous = this.lines[0];
    for (const entry of this.lines) {
      if (entry.line === lineNumber) return { previous: entry };
      if (entry.line > lineNumber) return { previous, next: entry };
      previous = entry;
    }
    return { previous };
  }

  private getLineElementsAtViewportTop(): {
    previous: CodeLineElement;
    next?: CodeLineElement;
  } {
    const visibleLines = this.lines.filter(line => line.isVisible);
    let low = -1;
    let high = visibleLines.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const bounds = this.getElementBounds(visibleLines[middle]);
      if (bounds.top + bounds.height >= 0) high = middle;
      else low = middle;
    }

    const highElement = visibleLines[high];
    if (!highElement) return { previous: this.lines[0] };
    const highBounds = this.getElementBounds(highElement);
    if (high >= 1 && highBounds.top > 0) {
      return { previous: visibleLines[low], next: highElement };
    }
    if (high > 1 && high < visibleLines.length && highBounds.top + highBounds.height > 0) {
      return { previous: highElement, next: visibleLines[high + 1] };
    }
    return { previous: highElement };
  }

  private getElementBounds(entry: CodeLineElement): ElementBounds {
    const bounds = entry.element.getBoundingClientRect();
    const containerBounds = this.scrollContainer.getBoundingClientRect();
    const top = bounds.top - containerBounds.top;
    if (entry.codeElement) return { top, height: bounds.height };

    const sourceLineChild = entry.element.querySelector(`.${CODE_LINE_CLASS}`);
    if (sourceLineChild) {
      return {
        top,
        height: Math.max(1, sourceLineChild.getBoundingClientRect().top - bounds.top),
      };
    }
    return { top, height: bounds.height };
  }

  private getContentBounds(entry: CodeLineElement): ElementBounds {
    const bounds = this.getElementBounds(entry);
    if (!entry.codeElement) return bounds;

    const style = window.getComputedStyle(entry.element);
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    return {
      top: bounds.top + paddingTop,
      height: bounds.height - paddingTop - paddingBottom,
    };
  }
}
