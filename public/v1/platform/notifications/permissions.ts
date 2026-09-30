import { hasPermission, type PlatformAuthContext } from '../auth.js';
import { forbidden } from '../errors.js';

export function notificationPermissions(auth: PlatformAuthContext): { personal: boolean; organization: boolean } {
  return { personal: hasPermission(auth, 'manage_own_notifications'), organization: hasPermission(auth, 'manage_notification_defaults') };
}

export function assertPersonalNotificationEdit(auth: PlatformAuthContext): void {
  if (!notificationPermissions(auth).personal) throw forbidden('notification_personal_edit_forbidden', 'Your role cannot change personal notification settings.');
}
