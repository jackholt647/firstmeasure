<?php
require_once __DIR__ . '/_storage.php';

if (!function_exists('mockCommsDefaultSettings')) {
    function mockCommsDefaultSettings() {
        return [
            'enabled' => false,
            'gmail_signature_html' => '<div><strong>FirstMate Test Mode</strong><br>Mock Gmail signature enabled.</div>',
            'gmail_mailbox_email' => 'testing@firstmate.local',
            'calendar_primary_summary' => 'FirstMate Test Calendar',
            'calendar_timezone' => 'America/Los_Angeles',
            'ringcentral_extension_name' => 'FirstMate Test SMS',
            'ringcentral_extension_email' => 'testing-sms@firstmate.local',
            'ringcentral_default_sms_number' => '+12065550199',
            'updated_at' => '',
        ];
    }
}

if (!function_exists('mockCommsNormalizeBool')) {
    function mockCommsNormalizeBool($value) {
        return !empty($value) && !in_array(strtolower(trim((string)$value)), ['0', 'false', 'off', 'no'], true);
    }
}

if (!function_exists('mockCommsNormalizeSettings')) {
    function mockCommsNormalizeSettings($raw) {
        $defaults = mockCommsDefaultSettings();
        $raw = is_array($raw) ? $raw : [];
        $settings = array_merge($defaults, $raw);
        $settings['enabled'] = mockCommsNormalizeBool($settings['enabled'] ?? false);
        $settings['gmail_signature_html'] = trim((string)($settings['gmail_signature_html'] ?? $defaults['gmail_signature_html']));
        if ($settings['gmail_signature_html'] === '') $settings['gmail_signature_html'] = $defaults['gmail_signature_html'];
        $mailboxEmail = strtolower(trim((string)($settings['gmail_mailbox_email'] ?? $defaults['gmail_mailbox_email'])));
        if ($mailboxEmail === '' || !filter_var($mailboxEmail, FILTER_VALIDATE_EMAIL)) {
            $mailboxEmail = $defaults['gmail_mailbox_email'];
        }
        $settings['gmail_mailbox_email'] = $mailboxEmail;
        $settings['calendar_primary_summary'] = trim((string)($settings['calendar_primary_summary'] ?? $defaults['calendar_primary_summary']));
        if ($settings['calendar_primary_summary'] === '') $settings['calendar_primary_summary'] = $defaults['calendar_primary_summary'];
        $settings['calendar_timezone'] = trim((string)($settings['calendar_timezone'] ?? $defaults['calendar_timezone']));
        if ($settings['calendar_timezone'] === '') $settings['calendar_timezone'] = $defaults['calendar_timezone'];
        $settings['ringcentral_extension_name'] = trim((string)($settings['ringcentral_extension_name'] ?? $defaults['ringcentral_extension_name']));
        if ($settings['ringcentral_extension_name'] === '') $settings['ringcentral_extension_name'] = $defaults['ringcentral_extension_name'];
        $extensionEmail = strtolower(trim((string)($settings['ringcentral_extension_email'] ?? $defaults['ringcentral_extension_email'])));
        if ($extensionEmail === '' || !filter_var($extensionEmail, FILTER_VALIDATE_EMAIL)) {
            $extensionEmail = $defaults['ringcentral_extension_email'];
        }
        $settings['ringcentral_extension_email'] = $extensionEmail;
        $digits = preg_replace('/\D+/', '', (string)($settings['ringcentral_default_sms_number'] ?? $defaults['ringcentral_default_sms_number']));
        if ($digits === '') $digits = preg_replace('/\D+/', '', (string)$defaults['ringcentral_default_sms_number']);
        if (strlen($digits) === 10) $digits = '1' . $digits;
        $settings['ringcentral_default_sms_number'] = '+' . $digits;
        $settings['updated_at'] = trim((string)($settings['updated_at'] ?? '')) ?: gmdate('c');
        return $settings;
    }
}

if (!function_exists('mockCommsSettings')) {
    function mockCommsSettings() {
        return mockCommsNormalizeSettings(serverConfigGet('mock_comms', []));
    }
}

if (!function_exists('mockCommsWriteSettings')) {
    function mockCommsWriteSettings(array $settings) {
        $normalized = mockCommsNormalizeSettings($settings);
        $normalized['updated_at'] = gmdate('c');
        serverConfigSet('mock_comms', $normalized);
        return $normalized;
    }
}

if (!function_exists('mockCommsEnabled')) {
    function mockCommsEnabled() {
        $settings = mockCommsSettings();
        return !empty($settings['enabled']);
    }
}

if (!function_exists('mockCommsRoot')) {
    function mockCommsRoot() {
        $dir = storagePath('meta/mock_comms');
        if (!is_dir($dir)) @mkdir($dir, 0777, true);
        return $dir;
    }
}

if (!function_exists('mockCommsActorKey')) {
    function mockCommsActorKey($actorEmail) {
        $actorEmail = strtolower(trim((string)$actorEmail));
        if ($actorEmail !== '') {
            $safe = preg_replace('/[^a-z0-9_\-]/', '_', str_replace(['@', '.'], ['_at_', '_'], $actorEmail));
            if ($safe !== '') return $safe;
        }
        return 'actor_' . substr(sha1($actorEmail !== '' ? $actorEmail : 'shared'), 0, 12);
    }
}

if (!function_exists('mockCommsReadJsonFile')) {
    function mockCommsReadJsonFile($path, $default = []) {
        if (!is_string($path) || $path === '' || !is_file($path)) return $default;
        $decoded = json_decode((string)file_get_contents($path), true);
        return is_array($decoded) ? $decoded : $default;
    }
}

if (!function_exists('mockCommsWriteJsonFile')) {
    function mockCommsWriteJsonFile($path, array $data) {
        if (!is_string($path) || $path === '') return false;
        $dir = dirname($path);
        if (!is_dir($dir)) @mkdir($dir, 0777, true);
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        return $json !== false ? (@file_put_contents($path, $json) !== false) : false;
    }
}

if (!function_exists('mockCommsListJsonRows')) {
    function mockCommsListJsonRows($pattern, $limit = 100, $sortKey = 'happened_at') {
        $rows = [];
        foreach (glob((string)$pattern) ?: [] as $path) {
            $row = mockCommsReadJsonFile($path, []);
            if (!is_array($row) || empty($row)) continue;
            $rows[] = $row;
        }
        usort($rows, function ($a, $b) use ($sortKey) {
            return ((int)($b[$sortKey] ?? 0)) <=> ((int)($a[$sortKey] ?? 0));
        });
        return $limit > 0 ? array_slice($rows, 0, $limit) : $rows;
    }
}

if (!function_exists('mockCommsUniqueId')) {
    function mockCommsUniqueId($prefix) {
        return trim((string)$prefix) . '_' . gmdate('YmdHis') . '_' . substr(bin2hex(random_bytes(8)), 0, 12);
    }
}

if (!function_exists('mockCommsSnippet')) {
    function mockCommsSnippet($text, $limit = 160) {
        $text = trim(preg_replace('/\s+/', ' ', (string)$text));
        if ($text === '') return '';
        return strlen($text) > $limit ? substr($text, 0, $limit - 1) . '...' : $text;
    }
}

if (!function_exists('mockCommsHtmlToText')) {
    function mockCommsHtmlToText($html) {
        $html = (string)$html;
        if ($html === '') return '';
        if (function_exists('gmailHtmlToPlainText')) return gmailHtmlToPlainText($html);
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = preg_replace('/\s+/', ' ', $text);
        return trim((string)$text);
    }
}

if (!function_exists('mockCommsExtractEmails')) {
    function mockCommsExtractEmails($value) {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $item) {
                foreach (mockCommsExtractEmails($item) as $email) $out[$email] = true;
            }
            return array_values(array_keys($out));
        }
        if (function_exists('gmailExtractEmails')) return gmailExtractEmails((string)$value);
        preg_match_all('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', (string)$value, $matches);
        $emails = [];
        foreach ($matches[0] ?? [] as $email) {
            $email = strtolower(trim((string)$email));
            if ($email !== '') $emails[$email] = true;
        }
        return array_values(array_keys($emails));
    }
}

if (!function_exists('mockCommsGmailActorDir')) {
    function mockCommsGmailActorDir($actorEmail) {
        $dir = mockCommsRoot() . '/gmail/' . mockCommsActorKey($actorEmail);
        foreach (['', '/messages'] as $suffix) {
            $path = $dir . $suffix;
            if (!is_dir($path)) @mkdir($path, 0777, true);
        }
        return $dir;
    }
}

if (!function_exists('mockCommsCalendarActorDir')) {
    function mockCommsCalendarActorDir($actorEmail) {
        $dir = mockCommsRoot() . '/calendar/' . mockCommsActorKey($actorEmail);
        foreach (['', '/events'] as $suffix) {
            $path = $dir . $suffix;
            if (!is_dir($path)) @mkdir($path, 0777, true);
        }
        return $dir;
    }
}

if (!function_exists('mockCommsCalendarEventPath')) {
    function mockCommsCalendarEventPath($actorEmail, $eventId) {
        $safe = preg_replace('/[^0-9A-Za-z_\-]/', '_', (string)$eventId);
        return $safe !== '' ? (mockCommsCalendarActorDir($actorEmail) . '/events/' . $safe . '.json') : '';
    }
}

if (!function_exists('mockCommsGmailStatePath')) {
    function mockCommsGmailStatePath($actorEmail) {
        return mockCommsGmailActorDir($actorEmail) . '/mailbox.json';
    }
}

if (!function_exists('mockCommsGmailMessagePath')) {
    function mockCommsGmailMessagePath($actorEmail, $messageId) {
        $safe = preg_replace('/[^0-9A-Za-z_\-]/', '_', (string)$messageId);
        return $safe !== '' ? (mockCommsGmailActorDir($actorEmail) . '/messages/' . $safe . '.json') : '';
    }
}

if (!function_exists('mockCommsGmailMailboxEmail')) {
    function mockCommsGmailMailboxEmail($actorEmail, array $settings = []) {
        $actorEmail = strtolower(trim((string)$actorEmail));
        if ($actorEmail !== '' && filter_var($actorEmail, FILTER_VALIDATE_EMAIL)) return $actorEmail;
        $settings = $settings ?: mockCommsSettings();
        return strtolower(trim((string)($settings['gmail_mailbox_email'] ?? 'testing@firstmate.local')));
    }
}

if (!function_exists('mockCommsReadGmailState')) {
    function mockCommsReadGmailState($actorEmail) {
        $settings = mockCommsSettings();
        $mailboxEmail = mockCommsGmailMailboxEmail($actorEmail, $settings);
        $default = [
            'actor_email' => strtolower(trim((string)$actorEmail)),
            'mailbox_email' => $mailboxEmail,
            'history_id_counter' => 1,
            'updated_at' => 0,
        ];
        return array_merge($default, mockCommsReadJsonFile(mockCommsGmailStatePath($actorEmail), []));
    }
}

if (!function_exists('mockCommsWriteGmailState')) {
    function mockCommsWriteGmailState($actorEmail, array $state) {
        $default = mockCommsReadGmailState($actorEmail);
        $merged = array_merge($default, $state);
        return mockCommsWriteJsonFile(mockCommsGmailStatePath($actorEmail), $merged);
    }
}

if (!function_exists('mockCommsCreateGmailMessage')) {
    function mockCommsCreateGmailMessage($actorEmail, array $payload) {
        $settings = mockCommsSettings();
        $actorEmail = strtolower(trim((string)$actorEmail));
        $state = mockCommsReadGmailState($actorEmail);
        $mailboxEmail = mockCommsGmailMailboxEmail($actorEmail, $settings);
        $direction = strtolower(trim((string)($payload['direction'] ?? 'out')));
        if (!in_array($direction, ['in', 'out'], true)) $direction = 'out';
        $messageId = trim((string)($payload['id'] ?? ''));
        if ($messageId === '') $messageId = mockCommsUniqueId('gmailmsg');
        $messageIdHeader = trim((string)($payload['message_id'] ?? ''));
        if ($messageIdHeader === '') $messageIdHeader = '<' . $messageId . '@mock.firstmate.local>';
        $threadId = trim((string)($payload['thread_id'] ?? ''));
        if ($threadId === '') $threadId = mockCommsUniqueId('gmailthread');
        $bodyHtml = trim((string)($payload['body_html'] ?? ''));
        $bodyText = trim((string)($payload['body_text'] ?? ''));
        if ($bodyText === '' && $bodyHtml !== '') $bodyText = mockCommsHtmlToText($bodyHtml);
        $fromEmail = strtolower(trim((string)($payload['from_email'] ?? ($direction === 'out' ? $mailboxEmail : 'external@example.com'))));
        $toEmails = array_values(array_unique(array_filter(mockCommsExtractEmails($payload['to_emails'] ?? ($payload['to'] ?? ($direction === 'out' ? '' : $mailboxEmail))))));
        if ($direction === 'in' && empty($toEmails)) $toEmails = [$mailboxEmail];
        $ccEmails = array_values(array_unique(array_filter(mockCommsExtractEmails($payload['cc_emails'] ?? ($payload['cc'] ?? '')))));
        $happenedAt = (int)($payload['happened_at'] ?? time());
        $historyCounter = max(1, (int)($state['history_id_counter'] ?? 1));
        $labelIds = is_array($payload['label_ids'] ?? null)
            ? array_values(array_filter(array_map('strval', $payload['label_ids'])))
            : ($direction === 'out' ? ['SENT'] : ['INBOX', 'UNREAD']);
        $row = [
            'id' => $messageId,
            'thread_id' => $threadId,
            'history_id' => (string)$historyCounter,
            'mailbox_email' => $mailboxEmail,
            'actor_email' => $actorEmail,
            'direction' => $direction,
            'from_email' => $fromEmail,
            'from_name' => trim((string)($payload['from_name'] ?? ($direction === 'out' ? 'FirstMate Test Mode' : 'Mock Sender'))),
            'to_emails' => $toEmails,
            'cc_emails' => $ccEmails,
            'subject' => trim((string)($payload['subject'] ?? '')),
            'body_text' => $bodyText,
            'body_html' => $bodyHtml,
            'message_id_header' => $messageIdHeader,
            'label_ids' => $labelIds,
            'snippet' => mockCommsSnippet($bodyText !== '' ? $bodyText : $bodyHtml),
            'references' => trim((string)($payload['references'] ?? '')),
            'in_reply_to' => trim((string)($payload['in_reply_to'] ?? '')),
            'happened_at' => $happenedAt,
            'stored_at' => time(),
        ];
        mockCommsWriteJsonFile(mockCommsGmailMessagePath($actorEmail, $messageId), $row);
        $state['history_id_counter'] = $historyCounter + 1;
        $state['updated_at'] = time();
        mockCommsWriteGmailState($actorEmail, $state);
        return $row;
    }
}

if (!function_exists('mockCommsGmailMessageRecord')) {
    function mockCommsGmailMessageRecord(array $row, $mailboxEmail, $now) {
        $fromEmail = strtolower(trim((string)($row['from_email'] ?? '')));
        $toEmails = array_values(array_unique(array_filter(array_map('strval', is_array($row['to_emails'] ?? null) ? $row['to_emails'] : []))));
        $ccEmails = array_values(array_unique(array_filter(array_map('strval', is_array($row['cc_emails'] ?? null) ? $row['cc_emails'] : []))));
        $fromName = trim((string)($row['from_name'] ?? ''));
        $fromLabel = $fromEmail !== '' ? ($fromName !== '' ? ($fromName . ' <' . $fromEmail . '>') : $fromEmail) : $fromName;
        return [
            'mailbox_email' => $mailboxEmail,
            'mailbox_key' => function_exists('gmailMailboxKey') ? gmailMailboxKey($mailboxEmail) : '',
            'gmail_message_id' => (string)($row['id'] ?? ''),
            'gmail_thread_id' => (string)($row['thread_id'] ?? ''),
            'gmail_history_id' => (string)($row['history_id'] ?? ''),
            'message_id_header' => (string)($row['message_id_header'] ?? ''),
            'direction' => strtolower(trim((string)($row['direction'] ?? 'out'))),
            'subject' => (string)($row['subject'] ?? ''),
            'body_text' => (string)($row['body_text'] ?? ''),
            'snippet' => (string)($row['snippet'] ?? mockCommsSnippet($row['body_text'] ?? '')),
            'from' => $fromLabel,
            'from_email' => $fromEmail,
            'from_emails' => $fromEmail !== '' ? [$fromEmail] : [],
            'to' => implode(', ', $toEmails),
            'to_emails' => $toEmails,
            'cc' => implode(', ', $ccEmails),
            'cc_emails' => $ccEmails,
            'label_ids' => array_values(array_filter(array_map('strval', is_array($row['label_ids'] ?? null) ? $row['label_ids'] : []))),
            'read_status' => function_exists('gmailReadStatusFromLabels')
                ? gmailReadStatusFromLabels(is_array($row['label_ids'] ?? null) ? $row['label_ids'] : [])
                : (in_array('UNREAD', is_array($row['label_ids'] ?? null) ? $row['label_ids'] : [], true) ? 'unread' : 'read'),
            'references' => (string)($row['references'] ?? ''),
            'in_reply_to' => (string)($row['in_reply_to'] ?? ''),
            'happened_at' => (int)($row['happened_at'] ?? $now),
            'stored_at' => (int)($row['stored_at'] ?? $now),
            'updated_at' => $now,
        ];
    }
}

if (!function_exists('mockCommsCalendarConnectionPublicState')) {
    function mockCommsCalendarConnectionPublicState($actorEmail) {
        $settings = mockCommsSettings();
        $connectedEmail = mockCommsGmailMailboxEmail($actorEmail, $settings);
        return [
            'configured' => true,
            'connected' => true,
            'testing_mode' => true,
            'mode' => 'mock',
            'connected_email' => $connectedEmail,
            'primary_calendar_id' => 'primary',
            'primary_calendar_summary' => (string)($settings['calendar_primary_summary'] ?? 'FirstMate Test Calendar'),
            'timezone' => (string)($settings['calendar_timezone'] ?? 'America/Los_Angeles'),
        ];
    }
}

if (!function_exists('mockCommsCalendarConnectedDataForActor')) {
    function mockCommsCalendarConnectedDataForActor($actorEmail) {
        $state = mockCommsCalendarConnectionPublicState($actorEmail);
        return [
            'email' => (string)($state['connected_email'] ?? ''),
            'calendar_primary_id' => (string)($state['primary_calendar_id'] ?? 'primary'),
            'calendar_primary_summary' => (string)($state['primary_calendar_summary'] ?? ''),
            'calendar_timezone' => (string)($state['timezone'] ?? ''),
        ];
    }
}

if (!function_exists('mockCommsCalendarBuildLinks')) {
    function mockCommsCalendarBuildLinks($actorEmail, $eventId, $conferenceId = '') {
        $actorKey = mockCommsActorKey($actorEmail);
        $base = 'https://mock.firstmate.local/calendar/' . rawurlencode($actorKey) . '/event/' . rawurlencode((string)$eventId);
        return [
            'htmlLink' => $base,
            'hangoutLink' => $conferenceId !== '' ? ($base . '/meet/' . rawurlencode($conferenceId)) : '',
        ];
    }
}

if (!function_exists('mockCommsCreateCalendarEventForActor')) {
    function mockCommsCreateCalendarEventForActor($actorEmail, array $payload) {
        $settings = mockCommsSettings();
        $timezone = trim((string)($payload['timezone'] ?? ($settings['calendar_timezone'] ?? 'America/Los_Angeles')));
        if ($timezone === '') $timezone = 'America/Los_Angeles';
        $eventId = trim((string)($payload['id'] ?? ''));
        if ($eventId === '') $eventId = mockCommsUniqueId('gcal');
        $conferenceId = !empty($payload['add_meet']) ? ('meet_' . substr(sha1($eventId), 0, 10)) : '';
        $links = mockCommsCalendarBuildLinks($actorEmail, $eventId, $conferenceId);
        $event = [
            'id' => $eventId,
            'status' => 'confirmed',
            'summary' => trim((string)($payload['summary'] ?? 'Scheduled follow-up')),
            'description' => (string)($payload['description'] ?? ''),
            'attendees' => array_values(array_map(function ($email) {
                return ['email' => strtolower(trim((string)$email))];
            }, array_values(array_filter(array_map('strval', (array)($payload['attendees'] ?? [])))))),
            'htmlLink' => $links['htmlLink'],
            'hangoutLink' => $links['hangoutLink'],
            'conferenceData' => $conferenceId !== '' ? [
                'conferenceId' => $conferenceId,
                'entryPoints' => [[
                    'entryPointType' => 'video',
                    'uri' => $links['hangoutLink'],
                    'label' => 'Google Meet',
                ]],
            ] : new stdClass(),
            'created' => gmdate('c'),
            'updated' => gmdate('c'),
        ];
        if (!empty($payload['all_day'])) {
            $allDayDate = trim((string)($payload['all_day_date'] ?? ''));
            try {
                $endDate = new DateTimeImmutable($allDayDate, new DateTimeZone($timezone));
                $endDate = $endDate->modify('+1 day');
                $event['start'] = ['date' => $allDayDate];
                $event['end'] = ['date' => $endDate->format('Y-m-d')];
            } catch (Throwable $e) {
                return ['ok' => false, 'error' => 'Could not build the mock all-day calendar event'];
            }
        } else {
            $startTs = (int)($payload['start_ts'] ?? 0);
            $endTs = (int)($payload['end_ts'] ?? 0);
            if ($startTs <= 0) return ['ok' => false, 'error' => 'Missing mock calendar event start time'];
            if ($endTs <= $startTs) {
                $endTs = $startTs + (max(15, min(480, (int)($payload['duration_minutes'] ?? 30))) * 60);
            }
            $event['start'] = [
                'dateTime' => function_exists('gmailIsoDateTimeInTimezone') ? gmailIsoDateTimeInTimezone($startTs, $timezone) : gmdate('Y-m-d\TH:i:s', $startTs),
                'timeZone' => $timezone,
            ];
            $event['end'] = [
                'dateTime' => function_exists('gmailIsoDateTimeInTimezone') ? gmailIsoDateTimeInTimezone($endTs, $timezone) : gmdate('Y-m-d\TH:i:s', $endTs),
                'timeZone' => $timezone,
            ];
        }
        mockCommsWriteJsonFile(mockCommsCalendarEventPath($actorEmail, $eventId), $event);
        return ['ok' => true, 'data' => $event];
    }
}

if (!function_exists('mockCommsCalendarListEventsForDateForActor')) {
    function mockCommsCalendarListEventsForDateForActor($actorEmail, $date, $timezone = '') {
        $date = trim((string)$date);
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            return ['ok' => false, 'error' => 'Pick a valid calendar date first.'];
        }
        $settings = mockCommsSettings();
        $tzName = trim((string)$timezone);
        if ($tzName === '') $tzName = trim((string)($settings['calendar_timezone'] ?? 'America/Los_Angeles'));
        $events = [];
        foreach (mockCommsListJsonRows(mockCommsCalendarActorDir($actorEmail) . '/events/*.json', 0, 'updated') as $row) {
            $status = strtolower(trim((string)($row['status'] ?? 'confirmed')));
            if ($status === 'cancelled') continue;
            $match = false;
            if (!empty($row['start']['date'])) {
                $match = trim((string)$row['start']['date']) === $date;
            } elseif (!empty($row['start']['dateTime'])) {
                try {
                    $dt = new DateTimeImmutable((string)$row['start']['dateTime'], new DateTimeZone((string)($row['start']['timeZone'] ?? $tzName)));
                    $dt = $dt->setTimezone(new DateTimeZone($tzName));
                    $match = $dt->format('Y-m-d') === $date;
                } catch (Throwable $e) {
                    $match = false;
                }
            }
            if ($match) $events[] = $row;
        }
        usort($events, function ($a, $b) {
            $aTs = !empty($a['start']['dateTime']) ? strtotime((string)$a['start']['dateTime']) : strtotime((string)($a['start']['date'] ?? ''));
            $bTs = !empty($b['start']['dateTime']) ? strtotime((string)$b['start']['dateTime']) : strtotime((string)($b['start']['date'] ?? ''));
            return ((int)$aTs) <=> ((int)$bTs);
        });
        return ['ok' => true, 'data' => ['items' => $events]];
    }
}

if (!function_exists('mockCommsCalendarGetEventForActor')) {
    function mockCommsCalendarGetEventForActor($actorEmail, $eventId) {
        $eventId = trim((string)$eventId);
        if ($eventId === '') return ['ok' => false, 'error' => 'Missing Google Calendar event id', 'status' => 0];
        $event = mockCommsReadJsonFile(mockCommsCalendarEventPath($actorEmail, $eventId), []);
        if (!is_array($event) || empty($event)) return ['ok' => false, 'error' => 'Mock calendar event not found', 'status' => 404];
        return ['ok' => true, 'data' => $event, 'status' => 200];
    }
}

if (!function_exists('mockCommsCalendarDeleteEventForActor')) {
    function mockCommsCalendarDeleteEventForActor($actorEmail, $eventId, $sendUpdates = true) {
        $eventId = trim((string)$eventId);
        if ($eventId === '') return ['ok' => false, 'error' => 'Missing Google Calendar event id', 'status' => 0];
        $event = mockCommsReadJsonFile(mockCommsCalendarEventPath($actorEmail, $eventId), []);
        if (!is_array($event) || empty($event)) return ['ok' => false, 'error' => 'Mock calendar event not found', 'status' => 404];
        $event['status'] = 'cancelled';
        $event['updated'] = gmdate('c');
        mockCommsWriteJsonFile(mockCommsCalendarEventPath($actorEmail, $eventId), $event);
        return ['ok' => true, 'status' => 204, 'data' => $event];
    }
}

if (!function_exists('mockCommsGmailConnectionPublicState')) {
    function mockCommsGmailConnectionPublicState($actorEmail) {
        $settings = mockCommsSettings();
        $mailboxEmail = mockCommsGmailMailboxEmail($actorEmail, $settings);
        $mailboxState = function_exists('gmailReadMailboxState') ? gmailReadMailboxState($mailboxEmail) : [];
        $realGmail = function_exists('gmailUserIntegrationData') ? gmailUserIntegrationData($actorEmail) : [];
        $expiresAt = (int)($realGmail['expires_at'] ?? 0);
        $tokenConnected = !empty($realGmail['refresh_token']) || (!empty($realGmail['access_token']) && $expiresAt > time());
        $calendarConnected = $tokenConnected && function_exists('gmailHasCalendarScopes') ? gmailHasCalendarScopes($realGmail) : false;
        return [
            'configured' => true,
            'connected' => true,
            'testing_mode' => true,
            'mode' => 'mock',
            'connected_email' => $mailboxEmail,
            'mailbox_email' => $mailboxEmail,
            'mailbox_key' => (string)($mailboxState['mailbox_key'] ?? ''),
            'expires_at' => 0,
            'redirect_uri' => '',
            'has_refresh_token' => false,
            'scopes' => function_exists('gmailScopes') ? gmailScopes() : [],
            'signature_scope_granted' => true,
            'signature_html' => (string)($settings['gmail_signature_html'] ?? ''),
            'signature_text' => mockCommsHtmlToText((string)($settings['gmail_signature_html'] ?? '')),
            'signature_updated_at' => (string)($settings['updated_at'] ?? ''),
            'send_as_email' => $mailboxEmail,
            'send_as_display_name' => 'FirstMate Test Mode',
            'sync' => [
                'initial_sync_complete' => !empty($mailboxState['initial_sync_complete']),
                'last_sync_at' => (int)($mailboxState['last_sync_at'] ?? 0),
                'last_sync_started_at' => (int)($mailboxState['last_sync_started_at'] ?? 0),
                'last_sync_status' => (string)($mailboxState['last_sync_status'] ?? ''),
                'last_sync_reason' => (string)($mailboxState['last_sync_reason'] ?? ''),
                'message_count' => (int)($mailboxState['message_count'] ?? 0),
                'unmatched_count' => (int)($mailboxState['unmatched_count'] ?? 0),
                'thread_count' => (int)($mailboxState['thread_count'] ?? 0),
            ],
            'calendar_connected' => true,
            'calendar' => mockCommsCalendarConnectionPublicState($actorEmail),
        ];
    }
}

if (!function_exists('mockCommsGmailSendMessageForActor')) {
    function mockCommsGmailSendMessageForActor($actorEmail, array $payload) {
        $row = mockCommsCreateGmailMessage($actorEmail, [
            'direction' => 'out',
            'thread_id' => $payload['thread_id'] ?? '',
            'to_emails' => $payload['to'] ?? ($payload['to_emails'] ?? []),
            'cc_emails' => $payload['cc'] ?? ($payload['cc_emails'] ?? []),
            'subject' => $payload['subject'] ?? '',
            'body_text' => $payload['body_text'] ?? '',
            'body_html' => $payload['body_html'] ?? '',
            'references' => $payload['references'] ?? '',
            'in_reply_to' => $payload['in_reply_to'] ?? '',
            'from_email' => mockCommsGmailMailboxEmail($actorEmail),
            'from_name' => $payload['from_name'] ?? 'FirstMate Test Mode',
            'label_ids' => ['SENT'],
            'happened_at' => time(),
        ]);
        return [
            'ok' => true,
            'id' => (string)($row['id'] ?? ''),
            'threadId' => (string)($row['thread_id'] ?? ''),
            'message_id_header' => (string)($row['message_id_header'] ?? ''),
            'data' => [
                'id' => (string)($row['id'] ?? ''),
                'threadId' => (string)($row['thread_id'] ?? ''),
                'labelIds' => ['SENT'],
            ],
            'mock' => true,
        ];
    }
}

if (!function_exists('mockCommsGmailSyncMailboxForActor')) {
    function mockCommsGmailSyncMailboxForActor(SQLite3 $db, $actorEmail, $now, $force = false, $reason = 'background') {
        $actorEmail = strtolower(trim((string)$actorEmail));
        $settings = mockCommsSettings();
        $mailboxEmail = mockCommsGmailMailboxEmail($actorEmail, $settings);
        $gmailSeed = ['email' => $mailboxEmail, 'history_id' => (string)(mockCommsReadGmailState($actorEmail)['history_id_counter'] ?? '1')];
        $state = function_exists('gmailRegisterMailboxForActor') ? gmailRegisterMailboxForActor($actorEmail, $gmailSeed, $now) : [];
        if (!$force && (int)($state['last_sync_started_at'] ?? 0) > 0 && ($now - (int)($state['last_sync_started_at'] ?? 0)) < 5) {
            return ['ok' => true, 'skipped' => 'sync_recently_started', 'mailbox' => $state];
        }
        $state['last_sync_started_at'] = $now;
        $state['last_sync_status'] = 'running';
        $state['last_sync_reason'] = (string)$reason;
        $state['last_sync_error'] = '';
        if (function_exists('gmailWriteMailboxState')) gmailWriteMailboxState($mailboxEmail, $state);

        $leadIndex = function_exists('gmailLeadAddressIndex') ? gmailLeadAddressIndex($db) : [];
        $rows = mockCommsListJsonRows(mockCommsGmailActorDir($actorEmail) . '/messages/*.json', 0);
        $examined = 0;
        $matched = 0;
        $unmatched = 0;
        $assigned = 0;
        $latestHistoryId = (string)($state['history_id'] ?? '');
        foreach ($rows as $row) {
            $examined++;
            $record = mockCommsGmailMessageRecord($row, $mailboxEmail, $now);
            $latestHistoryId = (string)($record['gmail_history_id'] ?? $latestHistoryId);
            $leadIds = function_exists('gmailLeadIdsForMessage') ? gmailLeadIdsForMessage($db, $record, $leadIndex) : [];
            if (empty($leadIds)) {
                if (function_exists('gmailWriteMailboxUnmatchedRecord')) gmailWriteMailboxUnmatchedRecord($mailboxEmail, $record, [], $now);
                $unmatched++;
                continue;
            }
            if (function_exists('gmailDeleteMailboxUnmatchedRecord')) gmailDeleteMailboxUnmatchedRecord($mailboxEmail, (string)($record['gmail_message_id'] ?? ''));
            if (function_exists('gmailStoreMatchedMessageRecord')) gmailStoreMatchedMessageRecord($mailboxEmail, $record, $leadIds, $now);
            if (function_exists('gmailAssignMessageRecordToLeadIds')) {
                $assigned += gmailAssignMessageRecordToLeadIds($db, $leadIds, $record, $actorEmail, $now);
            }
            $matched++;
        }
        $state = function_exists('gmailReadMailboxState') ? gmailReadMailboxState($mailboxEmail) : $state;
        $state['history_id'] = $latestHistoryId;
        $state['initial_sync_complete'] = true;
        $state['has_backfill_sync'] = true;
        $state['first_sync_at'] = (int)($state['first_sync_at'] ?? 0) ?: $now;
        $state['last_backfill_at'] = $now;
        $state['last_sync_at'] = $now;
        $state['last_sync_status'] = 'ok';
        $state['last_sync_reason'] = (string)$reason;
        $state['last_sync_error'] = '';
        $state['updated_at'] = $now;
        if (function_exists('gmailRefreshMailboxCounts')) $state = gmailRefreshMailboxCounts($mailboxEmail, $state);
        if (function_exists('gmailWriteMailboxState')) gmailWriteMailboxState($mailboxEmail, $state);
        if (function_exists('gmailMailboxLogSyncRun')) {
            gmailMailboxLogSyncRun($mailboxEmail, [
                'run_id' => gmdate('Ymd_His', $now) . '_' . substr(sha1($actorEmail . '|mock|' . $reason . '|' . $now), 0, 8),
                'status' => 'ok',
                'reason' => (string)$reason,
                'mode' => 'mock',
                'started_at' => $now,
                'finished_at' => $now,
                'actor_email' => $actorEmail,
                'examined_message_ids' => $examined,
                'stored_messages' => $matched,
                'unmatched_messages' => $unmatched,
                'assigned_activities' => $assigned,
                'truncated' => false,
                'history_id' => $latestHistoryId,
            ]);
        }
        return [
            'ok' => true,
            'mailbox' => $state,
            'mode' => 'mock',
            'examined_message_ids' => $examined,
            'stored_messages' => $matched,
            'unmatched_messages' => $unmatched,
            'assigned_activities' => $assigned,
            'mock' => true,
        ];
    }
}

if (!function_exists('mockCommsRingCentralActorDir')) {
    function mockCommsRingCentralActorDir($actorEmail) {
        $dir = mockCommsRoot() . '/ringcentral/' . mockCommsActorKey($actorEmail);
        foreach (['', '/messages', '/calls'] as $suffix) {
            $path = $dir . $suffix;
            if (!is_dir($path)) @mkdir($path, 0777, true);
        }
        return $dir;
    }
}

if (!function_exists('mockCommsRingCentralMessagePath')) {
    function mockCommsRingCentralMessagePath($actorEmail, $messageId) {
        $safe = preg_replace('/[^0-9A-Za-z_\-]/', '_', (string)$messageId);
        return $safe !== '' ? (mockCommsRingCentralActorDir($actorEmail) . '/messages/' . $safe . '.json') : '';
    }
}

if (!function_exists('mockCommsRingCentralCallPath')) {
    function mockCommsRingCentralCallPath($actorEmail, $callId) {
        $safe = preg_replace('/[^0-9A-Za-z_\-]/', '_', (string)$callId);
        return $safe !== '' ? (mockCommsRingCentralActorDir($actorEmail) . '/calls/' . $safe . '.json') : '';
    }
}

if (!function_exists('mockCommsRingCentralExtensionState')) {
    function mockCommsRingCentralExtensionState($actorEmail, array $state = []) {
        $settings = mockCommsSettings();
        $actorEmail = strtolower(trim((string)$actorEmail));
        $extensionKey = 'mock_' . substr(sha1($actorEmail !== '' ? $actorEmail : 'shared'), 0, 12);
        $defaultSmsNumber = (string)($settings['ringcentral_default_sms_number'] ?? '+12065550199');
        $extensionEmail = $actorEmail !== '' && filter_var($actorEmail, FILTER_VALIDATE_EMAIL)
            ? $actorEmail
            : (string)($settings['ringcentral_extension_email'] ?? 'testing-sms@firstmate.local');
        $phoneRow = [
            'id' => $extensionKey . '_sms',
            'phone_number' => $defaultSmsNumber,
            'payment_type' => 'External',
            'usage_type' => 'DirectNumber',
            'features' => ['SmsSender'],
            'sms_enabled' => true,
        ];
        return array_merge($state, [
            'account_id' => 'mock_account',
            'extension_id' => $extensionKey,
            'extension_key' => $extensionKey,
            'extension_uri' => '',
            'extension_email' => $extensionEmail,
            'extension_name' => (string)($settings['ringcentral_extension_name'] ?? 'FirstMate Test SMS'),
            'extension_number' => 'MOCK',
            'extension_status' => 'Enabled',
            'service_features' => ['SMS'],
            'phone_numbers' => [$phoneRow],
            'sms_numbers' => [$phoneRow],
            'default_sms_number' => $defaultSmsNumber,
            'actors' => $actorEmail !== '' ? [$actorEmail] : [],
            'updated_at' => gmdate('c'),
        ]);
    }
}

if (!function_exists('mockCommsCreateRingCentralSms')) {
    function mockCommsCreateRingCentralSms($actorEmail, array $payload) {
        $actorEmail = strtolower(trim((string)$actorEmail));
        $messageId = trim((string)($payload['ringcentral_id'] ?? $payload['id'] ?? ''));
        if ($messageId === '') $messageId = mockCommsUniqueId('rcsms');
        $direction = strtolower(trim((string)($payload['direction'] ?? 'outbound')));
        if (!in_array($direction, ['outbound', 'inbound'], true)) $direction = 'outbound';
        $fromPhone = trim((string)($payload['from_phone'] ?? ''));
        $toPhones = is_array($payload['to_phones'] ?? null)
            ? array_values(array_filter(array_map('strval', $payload['to_phones'])))
            : [];
        if (!$toPhones && !empty($payload['to_phone'])) $toPhones = [trim((string)$payload['to_phone'])];
        $conversationId = trim((string)($payload['conversation_id'] ?? ''));
        if ($conversationId === '') {
            $conversationId = 'conv_' . preg_replace('/\D+/', '', (string)($direction === 'inbound' ? $fromPhone : ($toPhones[0] ?? 'general')));
        }
        $externalPhone = trim((string)($payload['external_phone'] ?? ''));
        if ($externalPhone === '') $externalPhone = $direction === 'inbound' ? $fromPhone : (string)($toPhones[0] ?? '');
        $row = [
            'record_type' => 'sms',
            'ringcentral_id' => $messageId,
            'conversation_id' => $conversationId,
            'direction' => $direction,
            'subject' => trim((string)($payload['subject'] ?? ($payload['body_text'] ?? ''))),
            'body_text' => trim((string)($payload['body_text'] ?? '')),
            'from_phone' => $fromPhone,
            'to_phones' => $toPhones,
            'external_phone' => $externalPhone,
            'happened_at' => (int)($payload['happened_at'] ?? time()),
            'read_status' => trim((string)($payload['read_status'] ?? ($direction === 'inbound' ? 'Unread' : 'Read'))),
            'message_status' => trim((string)($payload['message_status'] ?? ($direction === 'inbound' ? 'Received' : 'Sent'))),
            'stored_at' => time(),
        ];
        mockCommsWriteJsonFile(mockCommsRingCentralMessagePath($actorEmail, $messageId), $row);
        return $row;
    }
}

if (!function_exists('mockCommsCreateRingCentralCall')) {
    function mockCommsCreateRingCentralCall($actorEmail, array $payload) {
        $actorEmail = strtolower(trim((string)$actorEmail));
        $callId = trim((string)($payload['ringcentral_id'] ?? $payload['id'] ?? ''));
        if ($callId === '') $callId = mockCommsUniqueId('rccall');
        $direction = strtolower(trim((string)($payload['direction'] ?? 'inbound')));
        if (!in_array($direction, ['inbound', 'outbound'], true)) $direction = 'inbound';
        $fromPhone = trim((string)($payload['from_phone'] ?? ''));
        $toPhones = is_array($payload['to_phones'] ?? null)
            ? array_values(array_filter(array_map('strval', $payload['to_phones'])))
            : [];
        if (!$toPhones && !empty($payload['to_phone'])) $toPhones = [trim((string)$payload['to_phone'])];
        $externalPhone = trim((string)($payload['external_phone'] ?? ''));
        if ($externalPhone === '') $externalPhone = $direction === 'inbound' ? $fromPhone : (string)($toPhones[0] ?? '');
        $row = [
            'record_type' => 'call',
            'ringcentral_id' => $callId,
            'session_id' => trim((string)($payload['session_id'] ?? mockCommsUniqueId('session'))),
            'telephony_session_id' => trim((string)($payload['telephony_session_id'] ?? mockCommsUniqueId('tele'))),
            'direction' => $direction,
            'action' => trim((string)($payload['action'] ?? ($direction === 'inbound' ? 'Phone Call' : 'Call Out'))),
            'result' => trim((string)($payload['result'] ?? 'Connected')),
            'type' => 'Voice',
            'from_phone' => $fromPhone,
            'to_phones' => $toPhones,
            'external_phone' => $externalPhone,
            'duration_seconds' => (int)($payload['duration_seconds'] ?? 0),
            'happened_at' => (int)($payload['happened_at'] ?? time()),
            'stored_at' => time(),
        ];
        mockCommsWriteJsonFile(mockCommsRingCentralCallPath($actorEmail, $callId), $row);
        return $row;
    }
}

if (!function_exists('mockCommsRingCentralConnectionPublicState')) {
    function mockCommsRingCentralConnectionPublicState($actorEmail = '') {
        $actorEmail = strtolower(trim((string)$actorEmail));
        $extensionKey = 'mock_' . substr(sha1($actorEmail !== '' ? $actorEmail : 'shared'), 0, 12);
        $existing = function_exists('ringcentralReadExtensionState') ? ringcentralReadExtensionState($extensionKey) : [];
        $state = mockCommsRingCentralExtensionState($actorEmail, $existing);
        return [
            'configured' => true,
            'connected' => true,
            'testing_mode' => true,
            'mode' => 'mock',
            'resolved_from' => 'mock',
            'mapped_extension_key' => (string)($state['extension_key'] ?? ''),
            'extension_key' => (string)($state['extension_key'] ?? ''),
            'account_id' => (string)($state['account_id'] ?? ''),
            'extension_id' => (string)($state['extension_id'] ?? ''),
            'extension_email' => (string)($state['extension_email'] ?? ''),
            'extension_name' => (string)($state['extension_name'] ?? ''),
            'extension_number' => (string)($state['extension_number'] ?? ''),
            'default_sms_number' => (string)($state['default_sms_number'] ?? ''),
            'sms_numbers' => is_array($state['sms_numbers'] ?? null) ? $state['sms_numbers'] : [],
            'actors' => is_array($state['actors'] ?? null) ? $state['actors'] : [],
            'last_error' => '',
            'expires_at' => 0,
            'scope' => 'mock',
            'sync' => [
                'initial_sync_complete' => !empty($state['initial_sync_complete']),
                'last_sync_started_at' => (int)($state['last_sync_started_at'] ?? 0),
                'last_sync_at' => (int)($state['last_sync_at'] ?? 0),
                'last_sync_status' => (string)($state['last_sync_status'] ?? ''),
                'last_sync_reason' => (string)($state['last_sync_reason'] ?? ''),
                'last_sync_error' => (string)($state['last_sync_error'] ?? ''),
                'message_count' => (int)($state['message_count'] ?? 0),
                'call_count' => (int)($state['call_count'] ?? 0),
                'unmatched_message_count' => (int)($state['unmatched_message_count'] ?? 0),
                'unmatched_call_count' => (int)($state['unmatched_call_count'] ?? 0),
            ],
        ];
    }
}

if (!function_exists('mockCommsRingCentralSyncForActor')) {
    function mockCommsRingCentralSyncForActor(SQLite3 $db, $actorEmail, $force = false, $reason = 'background') {
        $actorEmail = strtolower(trim((string)$actorEmail));
        $extensionKey = 'mock_' . substr(sha1($actorEmail !== '' ? $actorEmail : 'shared'), 0, 12);
        $existing = function_exists('ringcentralReadExtensionState') ? ringcentralReadExtensionState($extensionKey) : [];
        $state = mockCommsRingCentralExtensionState($actorEmail, $existing);
        if (!$force && (int)($state['last_sync_at'] ?? 0) >= (time() - 10)) {
            return ['ok' => true, 'skipped' => true, 'reason' => 'recent_sync', 'extension_key' => $extensionKey];
        }
        $runId = 'mockrc_' . substr(sha1($actorEmail . '|' . microtime(true)), 0, 10);
        $startedAt = time();
        $state['last_sync_started_at'] = $startedAt;
        $state['last_sync_status'] = 'running';
        $state['last_sync_reason'] = (string)$reason;
        $state['last_sync_error'] = '';
        if (function_exists('ringcentralWriteExtensionState')) ringcentralWriteExtensionState($state);

        $phoneIndex = function_exists('ringcentralBuildPhoneIndex') ? ringcentralBuildPhoneIndex($db) : [];
        $examinedMessages = 0;
        $examinedCalls = 0;
        $storedMessages = 0;
        $storedCalls = 0;
        $unmatchedMessages = 0;
        $unmatchedCalls = 0;
        $assignedActivities = 0;
        $assignedCalls = 0;

        foreach (mockCommsListJsonRows(mockCommsRingCentralActorDir($actorEmail) . '/messages/*.json', 0) as $row) {
            $message = array_merge($row, [
                'extension_key' => $extensionKey,
                'default_sms_number' => (string)($state['default_sms_number'] ?? ''),
                'owned_numbers' => is_array($state['sms_numbers'] ?? null) ? $state['sms_numbers'] : [],
            ]);
            $examinedMessages++;
            $associations = function_exists('ringcentralAssociationsForPhone')
                ? ringcentralAssociationsForPhone($phoneIndex, $message['external_phone'] ?? '')
                : [];
            $leadIds = [];
            foreach ($associations as $association) {
                $leadId = trim((string)($association['lead_id'] ?? ''));
                if ($leadId !== '') $leadIds[$leadId] = true;
            }
            $message['lead_ids'] = array_values(array_keys($leadIds));
            $message['association_status'] = !empty($leadIds) ? 'matched' : 'unmatched';
            if (!empty($leadIds)) {
                if (function_exists('ringcentralUpsertSmsAssociations')) {
                    $assignedActivities += ringcentralUpsertSmsAssociations($db, $state, $message, $associations, $actorEmail, $startedAt);
                }
                if (function_exists('ringcentralCacheMatchedMessage')) ringcentralCacheMatchedMessage($extensionKey, $message);
                $storedMessages++;
            } else {
                if (function_exists('ringcentralCacheUnmatchedMessage')) ringcentralCacheUnmatchedMessage($extensionKey, $message);
                $unmatchedMessages++;
            }
        }

        foreach (mockCommsListJsonRows(mockCommsRingCentralActorDir($actorEmail) . '/calls/*.json', 0) as $row) {
            $call = array_merge($row, [
                'extension_key' => $extensionKey,
                'default_sms_number' => (string)($state['default_sms_number'] ?? ''),
                'owned_numbers' => is_array($state['sms_numbers'] ?? null) ? $state['sms_numbers'] : [],
            ]);
            $examinedCalls++;
            $associations = function_exists('ringcentralAssociationsForPhone')
                ? ringcentralAssociationsForPhone($phoneIndex, $call['external_phone'] ?? '')
                : [];
            $leadIds = [];
            foreach ($associations as $association) {
                $leadId = trim((string)($association['lead_id'] ?? ''));
                if ($leadId !== '') $leadIds[$leadId] = true;
            }
            $call['lead_ids'] = array_values(array_keys($leadIds));
            $call['association_status'] = !empty($leadIds) ? 'matched' : 'unmatched';
            if (!empty($leadIds)) {
                if (function_exists('ringcentralUpsertCallAssociations')) {
                    $assignedCalls += ringcentralUpsertCallAssociations($db, $call, $associations, $actorEmail, $startedAt);
                }
                if (function_exists('ringcentralCacheMatchedCall')) ringcentralCacheMatchedCall($extensionKey, $call);
                $storedCalls++;
            } else {
                if (function_exists('ringcentralCacheUnmatchedCall')) ringcentralCacheUnmatchedCall($extensionKey, $call);
                $unmatchedCalls++;
            }
        }

        if (function_exists('ringcentralReassociateCachedUnmatchedMessages')) {
            $assignedActivities += ringcentralReassociateCachedUnmatchedMessages($db, $state, $phoneIndex, $actorEmail, $startedAt);
        }
        if (function_exists('ringcentralReassociateCachedUnmatchedCalls')) {
            $assignedCalls += ringcentralReassociateCachedUnmatchedCalls($db, $state, $phoneIndex, $actorEmail, $startedAt);
        }

        $finishedAt = time();
        if (function_exists('ringcentralCollectCounts')) $state = ringcentralCollectCounts($extensionKey, $state);
        $state['initial_sync_complete'] = true;
        $state['first_sync_at'] = (int)($state['first_sync_at'] ?? 0) ?: $startedAt;
        $state['last_pull_from'] = $startedAt;
        $state['last_sync_at'] = $finishedAt;
        $state['last_sync_status'] = 'ok';
        $state['last_sync_reason'] = (string)$reason;
        $state['last_sync_error'] = '';
        $state['sync_run_count'] = (int)($state['sync_run_count'] ?? 0) + 1;
        if (function_exists('ringcentralWriteExtensionState')) ringcentralWriteExtensionState($state);
        if (function_exists('ringcentralSyncRunPath') && function_exists('ringcentralWriteJsonFile')) {
            ringcentralWriteJsonFile(ringcentralSyncRunPath($extensionKey, $runId), [
                'id' => $runId,
                'started_at' => $startedAt,
                'finished_at' => $finishedAt,
                'status' => 'ok',
                'mode' => 'mock',
                'reason' => $reason,
                'error' => '',
                'examined_messages' => $examinedMessages,
                'examined_calls' => $examinedCalls,
                'stored_messages' => $storedMessages,
                'stored_calls' => $storedCalls,
                'unmatched_messages' => $unmatchedMessages,
                'unmatched_calls' => $unmatchedCalls,
                'assigned_activities' => $assignedActivities,
                'assigned_calls' => $assignedCalls,
            ]);
        }
        return [
            'ok' => true,
            'extension_key' => $extensionKey,
            'examined_messages' => $examinedMessages,
            'examined_calls' => $examinedCalls,
            'stored_messages' => $storedMessages,
            'stored_calls' => $storedCalls,
            'unmatched_messages' => $unmatchedMessages,
            'unmatched_calls' => $unmatchedCalls,
            'assigned_activities' => $assignedActivities,
            'assigned_calls' => $assignedCalls,
            'mock' => true,
        ];
    }
}

if (!function_exists('mockCommsRingCentralSendSmsForLead')) {
    function mockCommsRingCentralSendSmsForLead(SQLite3 $db, array $leadRow, $actorEmail, $toPhone, $body, $threadId, $now) {
        $extensionKey = 'mock_' . substr(sha1(strtolower(trim((string)$actorEmail)) !== '' ? strtolower(trim((string)$actorEmail)) : 'shared'), 0, 12);
        $existing = function_exists('ringcentralReadExtensionState') ? ringcentralReadExtensionState($extensionKey) : [];
        $state = mockCommsRingCentralExtensionState($actorEmail, $existing);
        $fromPhone = trim((string)($state['default_sms_number'] ?? ''));
        if ($fromPhone === '') return ['ok' => false, 'error' => 'No mock SMS number is configured.'];
        $messageRow = mockCommsCreateRingCentralSms($actorEmail, [
            'direction' => 'outbound',
            'from_phone' => $fromPhone,
            'to_phones' => [$toPhone],
            'external_phone' => $toPhone,
            'body_text' => $body,
            'message_status' => 'Sent',
            'read_status' => 'Read',
            'happened_at' => $now,
        ]);
        $leadId = trim((string)($leadRow['id'] ?? ''));
        $contactId = '';
        $contactName = '';
        if ($threadId !== '' && $threadId !== 'lead' && function_exists('leadContactRows')) {
            foreach (leadContactRows($db, $leadId) as $contact) {
                if ((string)($contact['id'] ?? '') === $threadId) {
                    $contactId = (string)($contact['id'] ?? '');
                    $contactName = (string)($contact['full_name'] ?? '');
                    break;
                }
            }
        }
        if (function_exists('ringcentralUpdateLeadActivity')) {
            ringcentralUpdateLeadActivity($db, $leadId, $actorEmail, [
                'owner_email' => (string)($state['extension_email'] ?? $actorEmail),
                'activity_type' => 'sms',
                'direction' => 'out',
                'subject' => 'Text Message',
                'body_text' => $body,
                'related_id' => (string)($messageRow['ringcentral_id'] ?? ''),
                'metadata' => [
                    'provider' => 'ringcentral',
                    'thread_id' => $contactId !== '' ? $contactId : ($threadId !== '' ? $threadId : 'lead'),
                    'contact_id' => $contactId,
                    'contact_name' => $contactName,
                    'phone' => $toPhone,
                    'from_phone' => $fromPhone,
                    'to_phones' => [$toPhone],
                    'conversation_id' => (string)($messageRow['conversation_id'] ?? ''),
                    'ringcentral_message_id' => (string)($messageRow['ringcentral_id'] ?? ''),
                    'message_status' => (string)($messageRow['message_status'] ?? ''),
                ],
                'happened_at' => (int)($messageRow['happened_at'] ?? $now),
            ], $now);
        }
        if (function_exists('ringcentralCacheMatchedMessage')) ringcentralCacheMatchedMessage((string)($state['extension_key'] ?? ''), array_merge($messageRow, [
            'lead_ids' => [$leadId],
            'association_status' => 'matched',
        ]));
        if (function_exists('ringcentralCollectCounts')) $state = ringcentralCollectCounts((string)($state['extension_key'] ?? ''), $state);
        if (function_exists('ringcentralWriteExtensionState')) ringcentralWriteExtensionState($state);
        return [
            'ok' => true,
            'message' => $messageRow,
            'state' => $state,
            'mock' => true,
        ];
    }
}

if (!function_exists('mockCommsRecentSnapshot')) {
    function mockCommsRecentSnapshot($limit = 30) {
        $gmail = [];
        foreach (glob(mockCommsRoot() . '/gmail/*/messages/*.json') ?: [] as $path) {
            $row = mockCommsReadJsonFile($path, []);
            if (!is_array($row) || empty($row)) continue;
            $gmail[] = $row;
        }
        usort($gmail, function ($a, $b) { return ((int)($b['happened_at'] ?? 0)) <=> ((int)($a['happened_at'] ?? 0)); });
        $ringcentralMessages = [];
        foreach (glob(mockCommsRoot() . '/ringcentral/*/messages/*.json') ?: [] as $path) {
            $row = mockCommsReadJsonFile($path, []);
            if (!is_array($row) || empty($row)) continue;
            $ringcentralMessages[] = $row;
        }
        usort($ringcentralMessages, function ($a, $b) { return ((int)($b['happened_at'] ?? 0)) <=> ((int)($a['happened_at'] ?? 0)); });
        $ringcentralCalls = [];
        foreach (glob(mockCommsRoot() . '/ringcentral/*/calls/*.json') ?: [] as $path) {
            $row = mockCommsReadJsonFile($path, []);
            if (!is_array($row) || empty($row)) continue;
            $ringcentralCalls[] = $row;
        }
        usort($ringcentralCalls, function ($a, $b) { return ((int)($b['happened_at'] ?? 0)) <=> ((int)($a['happened_at'] ?? 0)); });
        $calendarEvents = [];
        foreach (glob(mockCommsRoot() . '/calendar/*/events/*.json') ?: [] as $path) {
            $row = mockCommsReadJsonFile($path, []);
            if (!is_array($row) || empty($row)) continue;
            $calendarEvents[] = $row;
        }
        usort($calendarEvents, function ($a, $b) {
            return strtotime((string)($b['updated'] ?? $b['created'] ?? '')) <=> strtotime((string)($a['updated'] ?? $a['created'] ?? ''));
        });
        return [
            'gmail' => array_slice($gmail, 0, $limit),
            'ringcentral_messages' => array_slice($ringcentralMessages, 0, $limit),
            'ringcentral_calls' => array_slice($ringcentralCalls, 0, $limit),
            'calendar_events' => array_slice($calendarEvents, 0, $limit),
            'counts' => [
                'gmail' => count($gmail),
                'ringcentral_messages' => count($ringcentralMessages),
                'ringcentral_calls' => count($ringcentralCalls),
                'calendar_events' => count($calendarEvents),
            ],
        ];
    }
}

if (!function_exists('mockCommsDeleteDir')) {
    function mockCommsDeleteDir($dir) {
        if (!is_dir($dir)) return;
        foreach (array_diff(scandir($dir) ?: [], ['.', '..']) as $entry) {
            $path = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($path)) mockCommsDeleteDir($path);
            else @unlink($path);
        }
        @rmdir($dir);
    }
}

if (!function_exists('mockCommsResetData')) {
    function mockCommsResetData() {
        mockCommsDeleteDir(mockCommsRoot());
        return true;
    }
}

if (!function_exists('mockCommsSettingsSnapshot')) {
    function mockCommsSettingsSnapshot() {
        return [
            'can_manage' => function_exists('crmSettingsActorCanManage') ? crmSettingsActorCanManage() : false,
            'settings' => mockCommsSettings(),
            'recent' => mockCommsRecentSnapshot(),
        ];
    }
}

if (!function_exists('handleMockCommsActions')) {
    function handleMockCommsActions($action) {
        if (!in_array($action, [
            'mock_comms_settings_get',
            'mock_comms_settings_save',
            'mock_comms_inject_gmail',
            'mock_comms_inject_sms',
            'mock_comms_inject_call',
            'mock_comms_inject_calendar',
            'mock_comms_reset',
        ], true)) {
            return false;
        }

        requireLoginOrFail();
        $actor = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
        $canManage = function_exists('crmSettingsActorCanManage') ? crmSettingsActorCanManage($actor) : false;

        if ($action === 'mock_comms_settings_get') {
            echo json_encode(['success' => true] + mockCommsSettingsSnapshot());
            return true;
        }

        if (!$canManage) {
            echo json_encode(['success' => false, 'error' => 'You do not have permission to manage testing mode.']);
            return true;
        }

        if ($action === 'mock_comms_settings_save') {
            $settings = mockCommsWriteSettings([
                'enabled' => $_POST['enabled'] ?? false,
                'gmail_signature_html' => (string)($_POST['gmail_signature_html'] ?? ''),
                'gmail_mailbox_email' => (string)($_POST['gmail_mailbox_email'] ?? ''),
                'calendar_primary_summary' => (string)($_POST['calendar_primary_summary'] ?? ''),
                'calendar_timezone' => (string)($_POST['calendar_timezone'] ?? ''),
                'ringcentral_extension_name' => (string)($_POST['ringcentral_extension_name'] ?? ''),
                'ringcentral_extension_email' => (string)($_POST['ringcentral_extension_email'] ?? ''),
                'ringcentral_default_sms_number' => (string)($_POST['ringcentral_default_sms_number'] ?? ''),
            ]);
            echo json_encode([
                'success' => true,
                'settings' => $settings,
                'recent' => mockCommsRecentSnapshot(),
                'can_manage' => true,
            ]);
            return true;
        }

        if ($action === 'mock_comms_inject_gmail') {
            $targetActor = strtolower(trim((string)($_POST['actor_email'] ?? $actor)));
            $direction = strtolower(trim((string)($_POST['direction'] ?? 'in')));
            if (!in_array($direction, ['in', 'out'], true)) $direction = 'in';
            $row = mockCommsCreateGmailMessage($targetActor, [
                'direction' => $direction,
                'from_email' => (string)($_POST['from_email'] ?? ''),
                'to_emails' => (string)($_POST['to_emails'] ?? ''),
                'subject' => (string)($_POST['subject'] ?? ''),
                'body_text' => (string)($_POST['body_text'] ?? ''),
                'thread_id' => (string)($_POST['thread_id'] ?? ''),
                'label_ids' => $direction === 'in' ? ['INBOX', 'UNREAD'] : ['SENT'],
            ]);
            if (function_exists('leadDb')) mockCommsGmailSyncMailboxForActor(leadDb(), $targetActor, time(), true, 'testing_inject');
            echo json_encode([
                'success' => true,
                'message' => $row,
                'recent' => mockCommsRecentSnapshot(),
                'settings' => mockCommsSettings(),
                'can_manage' => true,
            ]);
            return true;
        }

        if ($action === 'mock_comms_inject_sms') {
            $targetActor = strtolower(trim((string)($_POST['actor_email'] ?? $actor)));
            $direction = strtolower(trim((string)($_POST['direction'] ?? 'inbound')));
            if (!in_array($direction, ['inbound', 'outbound'], true)) $direction = 'inbound';
            $settings = mockCommsSettings();
            $defaultFrom = $direction === 'inbound'
                ? (string)($_POST['from_phone'] ?? '+12065550123')
                : (string)($settings['ringcentral_default_sms_number'] ?? '+12065550199');
            $defaultTo = $direction === 'inbound'
                ? (string)($settings['ringcentral_default_sms_number'] ?? '+12065550199')
                : (string)($_POST['to_phone'] ?? '');
            $row = mockCommsCreateRingCentralSms($targetActor, [
                'direction' => $direction,
                'from_phone' => $defaultFrom,
                'to_phones' => [$defaultTo],
                'external_phone' => $direction === 'inbound' ? $defaultFrom : $defaultTo,
                'body_text' => (string)($_POST['body_text'] ?? ''),
                'message_status' => $direction === 'inbound' ? 'Received' : 'Sent',
                'read_status' => $direction === 'inbound' ? 'Unread' : 'Read',
            ]);
            if (function_exists('leadDb')) mockCommsRingCentralSyncForActor(leadDb(), $targetActor, true, 'testing_inject');
            echo json_encode([
                'success' => true,
                'message' => $row,
                'recent' => mockCommsRecentSnapshot(),
                'settings' => mockCommsSettings(),
                'can_manage' => true,
            ]);
            return true;
        }

        if ($action === 'mock_comms_inject_call') {
            $targetActor = strtolower(trim((string)($_POST['actor_email'] ?? $actor)));
            $direction = strtolower(trim((string)($_POST['direction'] ?? 'inbound')));
            if (!in_array($direction, ['inbound', 'outbound'], true)) $direction = 'inbound';
            $settings = mockCommsSettings();
            $defaultFrom = $direction === 'inbound'
                ? (string)($_POST['from_phone'] ?? '+12065550123')
                : (string)($settings['ringcentral_default_sms_number'] ?? '+12065550199');
            $defaultTo = $direction === 'inbound'
                ? (string)($settings['ringcentral_default_sms_number'] ?? '+12065550199')
                : (string)($_POST['to_phone'] ?? '');
            $row = mockCommsCreateRingCentralCall($targetActor, [
                'direction' => $direction,
                'from_phone' => $defaultFrom,
                'to_phones' => [$defaultTo],
                'external_phone' => $direction === 'inbound' ? $defaultFrom : $defaultTo,
                'action' => (string)($_POST['action'] ?? 'Phone Call'),
                'result' => (string)($_POST['result'] ?? 'Connected'),
                'duration_seconds' => (int)($_POST['duration_seconds'] ?? 0),
            ]);
            if (function_exists('leadDb')) mockCommsRingCentralSyncForActor(leadDb(), $targetActor, true, 'testing_inject');
            echo json_encode([
                'success' => true,
                'call' => $row,
                'recent' => mockCommsRecentSnapshot(),
                'settings' => mockCommsSettings(),
                'can_manage' => true,
            ]);
            return true;
        }

        if ($action === 'mock_comms_inject_calendar') {
            $targetActor = strtolower(trim((string)($_POST['actor_email'] ?? $actor)));
            $allDay = !empty($_POST['all_day']);
            $payload = [
                'summary' => (string)($_POST['summary'] ?? 'Mock Calendar Event'),
                'description' => (string)($_POST['description'] ?? ''),
                'timezone' => (string)($_POST['timezone'] ?? ''),
                'attendees' => mockCommsExtractEmails((string)($_POST['attendees'] ?? '')),
                'add_meet' => !empty($_POST['add_meet']),
            ];
            if ($allDay) {
                $payload['all_day'] = true;
                $payload['all_day_date'] = (string)($_POST['all_day_date'] ?? date('Y-m-d'));
            } else {
                $date = trim((string)($_POST['date'] ?? ''));
                $time = trim((string)($_POST['time'] ?? '09:00'));
                $timestamp = strtotime($date . ' ' . $time);
                $payload['start_ts'] = $timestamp ?: time();
                $payload['duration_minutes'] = max(15, min(480, (int)($_POST['duration_minutes'] ?? 30)));
                $payload['end_ts'] = $payload['start_ts'] + ($payload['duration_minutes'] * 60);
            }
            $event = mockCommsCreateCalendarEventForActor($targetActor, $payload);
            echo json_encode([
                'success' => !empty($event['ok']),
                'error' => $event['error'] ?? '',
                'event' => $event['data'] ?? null,
                'recent' => mockCommsRecentSnapshot(),
                'settings' => mockCommsSettings(),
                'can_manage' => true,
            ]);
            return true;
        }

        if ($action === 'mock_comms_reset') {
            mockCommsResetData();
            echo json_encode([
                'success' => true,
                'settings' => mockCommsSettings(),
                'recent' => mockCommsRecentSnapshot(),
                'can_manage' => true,
            ]);
            return true;
        }

        return false;
    }
}
