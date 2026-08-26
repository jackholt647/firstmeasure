<?php

if (!defined('FIRSTMATE_PUBLIC_ROOT')) {
    define('FIRSTMATE_PUBLIC_ROOT', __DIR__);
}

if (!defined('FIRSTMATE_PROJECT_ROOT')) {
    define('FIRSTMATE_PROJECT_ROOT', dirname(FIRSTMATE_PUBLIC_ROOT));
}

if (!defined('FIRSTMATE_MEASURE_ROOT')) {
    define('FIRSTMATE_MEASURE_ROOT', FIRSTMATE_PUBLIC_ROOT . '/measure');
}

if (!function_exists('firstmatePath')) {
    function firstmatePath(string $relative = ''): string {
        $relative = ltrim(str_replace('\\', '/', $relative), '/');
        if ($relative === '') {
            return FIRSTMATE_PROJECT_ROOT;
        }
        return FIRSTMATE_PROJECT_ROOT . '/' . $relative;
    }
}

if (!function_exists('firstmatePublicPath')) {
    function firstmatePublicPath(string $relative = ''): string {
        $relative = ltrim(str_replace('\\', '/', $relative), '/');
        if ($relative === '') {
            return FIRSTMATE_PUBLIC_ROOT;
        }
        return FIRSTMATE_PUBLIC_ROOT . '/' . $relative;
    }
}
