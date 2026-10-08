# Mask rectangles in the rotated view - October 8, 2026

Height-map rectangles now use the screen axes at gesture start for drawing,
erasing and the live outline. The saved mask remains in source-image pixels,
so subsequent view rotation does not move an existing mask. Brush behavior and
crop remain independent.

Seven tests passed, including a real browser drag/erase at 45 degrees checked
pixel by pixel, undo, rotation after painting, and numeric cases at positive,
negative and right-angle rotations. Preview corners share the paint transform.
Evidence: `output/mask-rectangle-rotation-20261008/tests.txt`.

Development rollout verification pending. No project data or configuration changes.
