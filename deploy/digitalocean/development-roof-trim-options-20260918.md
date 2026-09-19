# Development roof trim defaults and selection — September 18, 2026

Runtime `9d5ae2be91dbea3c50798ea42ea6292977ae1470`; baseline `f4af452c4556d5b0fa288fe5fc0688047a9c85a3`.

Roof trim starts at zero height unless an edge has an explicit saved height. Manual settings remain intact. Eaves and Rakes replace Select perimeter in the Trim menu, selecting the corresponding classified edges without applying a height. Perimeter extraction retains the classification and does not merge a collinear eave into a rake.

Validation: 894 regression checks covered. The broad run passed 893 and exposed one fascia texture fixture relying on automatic six-inch trim; that fixture now explicitly creates six-inch fascia, and all 18 finish tests pass on rerun. Menu tests verify separate selection and no settings mutation; roof tests verify saved heights, removal and zero defaults.

Root files were synchronized after baseline comparison. Deploy only the two roof trim scripts to development worker, web and legacy; verify unchanged runtime files, readiness, isolation and public bytes. Production is unchanged.
