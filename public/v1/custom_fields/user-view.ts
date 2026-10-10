/** User fields have their own authorized publication path. Never spread them
 * into authentication, identity, or generic organization-member responses. */
export function withoutUserFieldValues<T extends Record<string, unknown>>(value: T): Omit<T, "custom_field_values" | "custom_fields" | "contact_custom_field_values" | "custom_field_schema"> {
  const {custom_field_values: _values, custom_fields: _aliases, contact_custom_field_values: _contacts, custom_field_schema: _schema, ...publicValue} = value;
  return publicValue;
}
