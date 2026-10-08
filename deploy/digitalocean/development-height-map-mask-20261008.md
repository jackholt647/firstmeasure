# Height-map masking — development, October 8, 2026

Wall mode's 2D header now has Mask height map, Draw/Erase, Brush/Rectangle,
brush size, Undo/Redo and Clear mask. The tinted image-space overlay follows
zoom, pan and rotation. Escape cancels a pending gesture or exits masking.
Mask gestures take priority over geometry editing; navigation and project Save
remain available.

The mask removes selected DSM triangles from rendering and ray picking. It is
independent of Crop and does not change source elevations, roof calculations,
generated walls, or Google 3D tiles. Closing the tools keeps the mask applied;
leaving wall mode restores the unmasked reference mesh. Clear retains Crop.

Masks are backed up per project locally and saved in `exteriorsHeightMask`
project metadata as compact pixel runs. The image dimensions, map center and
scale are checked before restoring to avoid applying a mask to different imagery.
The existing project Save action persists masks across devices. Gesture undo and
redo are available while masking, including Ctrl/Cmd+Z and redo shortcuts.

Validation: 85 focused tests passed, including a Chrome browser test exercising
brush/rectangle gestures, erasure, clear, undo/redo, cancellation, image rotation,
save/restore, crop composition and masked-ground ray picking. Source DSM values
remain unchanged. Evidence and the six-file development manifest are retained in
`output/height-map-mask-20261008/`. Deployment verification is pending.
