# Japanese language pack — development

The ja-JP interface pack contains all 8,988 messages in the current development catalog, with no English fallback. The handoff contained 8,985 response slots: 8,983 translated entries and two deliberately unresolved ICU labels. Those labels were completed with placeholder-preserving Japanese text; four newer error messages were added for the current catalog.

The pack passed `translation-kit.mjs register --locale ja-JP --label 日本語`. The localization compiler emitted the ja-JP catalog bundles and runtime manifest. The backend language registry was rebuilt so preference updates accept ja-JP. No database or provider settings changed.

The exact development web baseline was verified on both serving nodes: `26440daf1f29e011867d27a74ccf1aeb99581c1c`. Source commit is being advanced from that baseline and staged to both web nodes. Only web roles need this static catalog and locale-registry update; worker and compatibility services are unchanged. Production is unchanged.
