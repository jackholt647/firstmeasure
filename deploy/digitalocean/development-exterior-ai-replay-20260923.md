# Development: reuse exterior captures for repeated inference

Release `31f1f62a5b09b48e36415d7b6601f0936a8484e6` updates exterior_ai.js and exterior_ai.php, preserving the complete `d5140bc5f217cc16f857fa4bfe480c1d4d57b9dc` development baseline. Production is unchanged.

Capture 8 views now only captures. Ask Luna sends the saved reference and eight images with the original capture context, so repeated calls isolate model output variation. Last saved run supports earlier complete eight-view captures. Camera rotation no longer overwrites capture aspect metadata. New captures retain all sixteen possible camera positions, including midpoint grade heights. If current model bounds changed, the response is saved but automatic movement is blocked.

Every successful call retains its timestamp, full provider response, parsed decision and usage in browser IndexedDB and JSON export. A compact history lists the decisions. Chrome console groups under [Exterior AI] contain the complete returned response and parsed decision. Luna returns a choice, confidence and explanation, rather than a sixteen-position probability distribution.

Jev integration was deferred at the user's request after verification that TypeSafe Jev 1.13 is text-only (https://docs.typesafe.ai/models). No OpenRouter credential was deployed or used for inference. Independent image-based projects found during research include https://github.com/hr98w/jev-visual and the creator's Qevi-2B announcement at https://www.reddit.com/r/huggingface/comments/1wnz751/qevi2b_a_jevstyle_finetuned_model_for_image/ . These are not TypeSafe's hosted Jev model.

Validation: four focused AI/profiler tests passed. Repeated requests have identical images/context, work while canvas encoding is disabled, retain full responses and emit console logs. Existing single/midpoint positioning, manual rotation, history, stale-project and texture-failure behavior remain covered. Rollout evidence is in ignored output/exterior-ai-replay-20260923. Rollback uses the complete prior baseline and existing guarded development workflow.

PHP lint passed. All three development roles activated and verified with development-data/readiness guards. The public AI script hash matches the release.
