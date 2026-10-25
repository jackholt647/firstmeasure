/**
 * Loads every covered plugin's access table before `buildApp` registers the
 * plugins (docs/architecture/request-security.md#route-access-declarations).
 */
import "../../internal/route-access.js";
import "../../public-firstmeasure/route-access.js";
import "../../firstmeasure/route-access.js";
