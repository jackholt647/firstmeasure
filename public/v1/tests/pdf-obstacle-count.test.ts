import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function extractFunction(source: string, name: string, nextName: string) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} is available`);
  return source.slice(start, end);
}

test("PDF chimney count uses connected outlines instead of raw duplicated segments", async () => {
  const source = await readFile(
    new URL("../../measure/internal/editor_scripts/pdf.js", import.meta.url),
    "utf8"
  );
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "getPdfLinePointPair", "getPdfLineEndpointKey"), context);
  vm.runInContext(extractFunction(source, "countConnectedRoofFeatures", "formatLineType"), context);
  vm.runInContext(extractFunction(source, "groupSkylightsCorrectly", "getClusterCenter"), context);

  const rectangle = [
    { type: "chimney_back", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { type: "chimney_edge", points: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
    { type: "chimney_front", points: [{ x: 10, y: 10 }, { x: 0, y: 10 }] },
    { type: "chimney_edge", points: [{ x: 0, y: 10 }, { x: 0, y: 0 }] }
  ];
  const duplicatedEdges = [...rectangle, ...rectangle.map(line => ({
    ...line,
    points: line.points.map(point => ({ ...point }))
  }))];
  const secondRectangle = rectangle.map(line => ({
    ...line,
    points: line.points.map(point => ({ x: point.x + 100, y: point.y }))
  }));

  context.lines = duplicatedEdges;
  assert.equal(
    vm.runInContext("countConnectedRoofFeatures(lines, ['chimney_edge', 'chimney_back', 'chimney_front'])", context),
    1,
    "duplicate records for one connected chimney count once"
  );
  context.lines = [...duplicatedEdges, ...secondRectangle];
  assert.equal(
    vm.runInContext("countConnectedRoofFeatures(lines, ['chimney_edge', 'chimney_back', 'chimney_front'])", context),
    2,
    "separate chimney outlines still count separately"
  );
  for (const shape of ['start/end', 'conn']) {
    context.lines = [...duplicatedEdges, ...secondRectangle].map(line => ({
      type: line.type,
      ...(shape === 'conn'
        ? { conn: { start: line.points[0], end: line.points[1] } }
        : { start: line.points[0], end: line.points[1] })
    }));
    assert.equal(vm.runInContext("countConnectedRoofFeatures(lines, ['chimney_edge', 'chimney_back', 'chimney_front'])", context), 2, `${shape} structure geometry renders without crashing or duplicating chimneys`);
    context.lines = context.lines.map((line: object) => ({ ...line, type: 'skylight' }));
    assert.equal(vm.runInContext("countConnectedRoofFeatures(lines, ['skylight'])", context), 2);
  }
  context.lines = [{ type: 'skylight' }, { type: 'skylight', points: [null, null] }];
  assert.equal(vm.runInContext("countConnectedRoofFeatures(lines, ['skylight'])", context), 0);
});
