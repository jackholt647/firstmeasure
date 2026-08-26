<?php
require_once __DIR__ . '/_data_agent.php';

$runId = isset($argv[1]) ? (string)$argv[1] : '';
if ($runId === '') {
    fwrite(STDERR, "Missing run id\n");
    exit(1);
}

dataAgentRunBackgroundJob($runId);
