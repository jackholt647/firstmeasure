<?php
function fm_tutorial_assigned_course_ids($user) {
    $values = is_array($user['assigned_tutorial_course_ids'] ?? null)
        ? $user['assigned_tutorial_course_ids'] : [$user['assigned_tutorial_course_id'] ?? ''];
    $values = array_map(function($value) { return strtolower(trim((string)$value)); }, $values);
    return array_values(array_unique(array_intersect($values, ['software-update-refresh', 'full-house-drawing'])));
}
function fm_tutorial_has_course($user, $courseId) {
    return $courseId === 'default' || in_array($courseId, fm_tutorial_assigned_course_ids($user), true);
}
