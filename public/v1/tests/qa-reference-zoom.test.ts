import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../measure/internal/editor_scripts/report.js', import.meta.url), 'utf8');

test('embedded QA references zoom, pan, reset on navigation and close', () => {
  class Element {
    listeners: Record<string, Function> = {};
    classes = new Set<string>();
    style: Record<string, string> = {};
    textContent = ''; src = ''; hidden = false; disabled = false; parentElement: unknown;
    classList = { toggle: (name: string, yes: boolean) => yes ? this.classes.add(name) : this.classes.delete(name), add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
    constructor(public attrs: Record<string, string> = {}) {}
    addEventListener(name: string, handler: Function) { this.listeners[name] = handler; }
    fire(name: string, event = {}) { this.listeners[name]?.({ preventDefault() {}, ...event }); }
    getAttribute(name: string) { return this.attrs[name]; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    focus() {} setPointerCapture() {} remove() {}
    querySelector(selector: string): any { return elements[selector] || null; }
    querySelectorAll(selector: string): Element[] { return selector === '[data-qa-src-zoom]' ? controls : selector === '[data-qa-src-index]' ? [thumb] : []; }
  }
  const controls = ['out', 'in', 'fit'].map(action => new Element({ 'data-qa-src-zoom': action }));
  const thumb = new Element({ 'data-qa-src-index': '0' });
  const image = new Element(), modal = new Element(), stage = new Element();
  const value = new Element();
  const elements: Record<string, Element> = {
    '#qaSrcReviewCard': new Element(), '#qaSrcReviewModal': modal,
    '.qa-src-modal-img': image, '.qa-src-modal-stage': stage,
    '[data-qa-src-zoom-value]': value, '[data-qa-src-zoom-tools]': new Element(),
    '[data-qa-src-next]': new Element(), '[data-qa-src-close]': new Element()
  };
  const body = { querySelectorAll: () => [], appendChild: (el: Element) => { el.parentElement = body; } };
  const context = vm.createContext({ document: { body }, normalizeQaSubmissionSourcesForReview: () => ({ notes: '', images: [{ url: 'first.png' }, { url: 'second.png' }] }) });
  vm.runInContext(source.slice(source.indexOf('function wireQaSubmissionSourcesReview('), source.indexOf('function postQaPdfDecision(')), context);
  context.wireQaSubmissionSourcesReview(new Element(), {});
  thumb.fire('click');
  assert.equal(image.src, 'first.png');
  controls[1]!.fire('click');
  assert.equal(value.textContent, '150%');
  image.fire('pointerdown', { button: 0, clientX: 10, clientY: 20, pointerId: 1 });
  image.fire('pointermove', { clientX: 40, clientY: 60 });
  assert.equal(image.style.transform, 'translate(30px, 40px) scale(1.5)');
  image.fire('pointerup');
  assert.equal(image.classes.has('dragging'), false);
  stage.fire('wheel', { deltaY: -1 });
  assert.equal(value.textContent, '200%');
  for (let i = 0; i < 15; i++) controls[1]!.fire('click');
  assert.equal(value.textContent, '600%');
  assert.equal(controls[1]!.disabled, true);
  elements['[data-qa-src-next]']!.fire('click');
  assert.equal(image.src, 'second.png');
  assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)');
  modal.fire('keydown', { key: '+' });
  assert.equal(value.textContent, '150%');
  modal.fire('keydown', { key: '0' });
  assert.equal(value.textContent, '100%');
  image.fire('dblclick');
  assert.equal(value.textContent, '200%');
  elements['[data-qa-src-close]']!.fire('click');
  assert.equal(modal.classes.has('show'), false);
  assert.equal(value.textContent, '100%');
});
