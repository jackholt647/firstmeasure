# Development opaque imagery performance — September 18, 2026

Runtime `c21d3dc6426c1f54360d897b44d8501a40be5b41`; baseline `4b82d3564e580233785462df2012a33443286c75`.

Opaque point and label visibility collected every solid mesh in the scene, including the image-resolution DSM and photogrammetry tiles. Every drafting anchor then raycast those dense reference meshes. This work repeated on camera changes and entering opaque display, independently of the roof mask.

Mark the DSM image mesh and Google tile root as reference imagery. The shared point/label occlusion collector excludes those meshes and their descendants. Editable wall, base and roof meshes remain occluders; hidden point anchors and labels still disappear completely.

A controlled Three.js test with 64 markers and a 524,288-triangle image mesh took 893 ms before the fix (64 image raycasts) and under 1 ms afterward (zero image raycasts). This is a synthetic benchmark, not a timing of the user's browser. All 902 regression tests pass, including direct DSM and nested tile exclusions, mode changes, camera motion, wall occlusion and label recovery. scene_3d.js passes the syntax check.

Root files were synchronized after matching their baseline against the isolated checkout. Deploy only the two committed scripts to development worker, web and legacy using baseline hashes and unchanged-file verification. Production is not activated.
