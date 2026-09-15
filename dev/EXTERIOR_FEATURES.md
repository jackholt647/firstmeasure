# Exterior feature editing

`public/measure/internal/editor_scripts/wall_features.js` owns the catalog and pure sizing/placement math. Add a feature with `WallFeatures.register({id,name,color,icon,sizes:[{w,h,shape}]})`; preset widths/heights are feet and sketch coordinates remain metres. Optional `key` describes the catalog shortcut; register its key routing in the face editor when adding a new shortcut.

The exterior strip is in the same lower-right location as the roof library and is separate from roof tools. Choose a tile and click a 3D face. Click the library tile again to cycle the placement size; R swaps orientation; Shift-click keeps placing; Escape cancels. Existing selected faces can be labeled with W/D without changing their dimensions, then resized by repeating the shortcut. The selection panel above the library shows the selected type and dimensions. Expand it for a row of type buttons and a row of size buttons; changing type keeps the current size. The panel minimizes during movement, and right-click remains available for camera navigation.

Features are real closed draft polygons, with `feature` metadata on the draft region (and on generated caps after extrusion). Metadata survives graph resolution and serialization. Preset changes and nudges use the normal edit history, validate the host outline and feature overlaps, and roll back failed changes. Split nodes are retained when a curve changes shape; a rectangle can therefore have additional collinear boundary points.

Resize axes are stored with the feature. Shared host edges and corners anchor resizing; otherwise the center stays fixed. Arrow keys move selected shapes or stretch selected edges in the supporting face plane: 1 inch normally, 6 inches with Shift, 1/4 inch with Alt.

Feature dimensions default on independently of line lengths. Line lengths support `all`, `moving`, and `off`; feature edges are excluded to avoid duplicating their centered dimensions. Legacy `wallLengths` settings migrate through the mode fallback.

Focused coverage: `dev/wall-features.test.cjs`, feature cases in `dev/wall-face-draft.test.cjs`, and `dev/wall-mode.test.cjs`. Run these alongside the existing wall/base geometry and editor suite.

Browser integration: open `public/measure/internal/editor_tests/exterior_feature_fixture.html` through the isolated local server and click Run feature smoke test. It uses synthetic state, the real Three.js renderer and pointer events, and does not save a project.

Arrow nudges use the current camera projection to orient the face's horizontal and vertical directions. Looking at the reverse side reverses the world direction of Left/Right while keeping wall movement level. The direction is recalculated on every press, including after orbiting with a feature or line still selected. Face winding does not determine movement direction. The one-inch default and Shift/Alt increments are unchanged. The feature browser fixture's camera test covers front/back/oblique views, edge stretching and undo/redo.

Contained faces use M to cycle In/Out, Left/Right, Up/Down and Free on face. Every switch restores the gesture baseline before changing constraint; Escape restores the original edit state and the next M starts at In/Out. In-face modes use the shared sketch graph, preserve metadata, reject overlapping/out-of-host placements, and commit one undo record. An arrow through the actual feature bounds center shows direction, with the mode label above and feature dimensions below. E still extrudes.
