/**
 * Test fixtures for config library defaults (docs/architecture/config-library.md). A test that changes a default
 * reads the library from its store (CONFIG_LIBRARY_SOURCE=store, under the test's PLATFORM_STORAGE_ROOT) and writes
 * the entry the way an operator does. Call after the test's storage environment is set.
 */
export const TEST_LIBRARY_AUTHOR = { kind: "person" as const, id: "operator@1m8.test" };

export function useLibraryStore() {
  process.env.CONFIG_LIBRARY_SOURCE = "store";
}

/** The app flags every newly registered organization starts with (library entry app_flag_defaults/new_organization). */
export async function seedNewOrganizationAppFlags(appFlags: Record<string, Record<string, boolean | number | string>>) {
  useLibraryStore();
  const { saveNewOrganizationAppFlagOverrides } = await import("../../platform/app_flags.js");
  return saveNewOrganizationAppFlagOverrides({ app_flags: appFlags }, TEST_LIBRARY_AUTHOR);
}
