<?php

declare(strict_types=1);

namespace DedrisGenAI\PhpApi;

use DateTimeImmutable;
use RuntimeException;

/**
 * Small helper responsible for executing prompts received by the daemon.
 */
class PromptExecutor
{
    public const DEFAULT_LOG = __DIR__ . '/prompt_daemon.log';

    /** @var string|null */
    private $logFile;

    public function __construct(?string $logFile = self::DEFAULT_LOG)
    {
        $this->logFile = $logFile;
    }

    /**
     * Execute the provided prompt and return a structured response.
     *
     * The current implementation simply echoes the prompt back and returns
     * metadata about when the execution occurred. Replace the body of this
     * method with the actual logic that should run when a prompt is received.
     */
    public function execute(string $prompt): array
    {
        if ($prompt === '') {
            throw new RuntimeException('Prompt must not be empty.');
        }

        $timestamp = (new DateTimeImmutable('now'))->format(DATE_ATOM);

        $result = [
            'prompt' => $prompt,
            'response' => sprintf('Prompt processed at %s', $timestamp),
            'timestamp' => $timestamp,
        ];

        $this->logExecution($prompt, $timestamp);

        return $result;
    }

    private function logExecution(string $prompt, string $timestamp): void
    {
        if ($this->logFile === null) {
            return;
        }

        $entry = sprintf("[%s] prompt: %s\n", $timestamp, $prompt);
        file_put_contents($this->logFile, $entry, FILE_APPEND | LOCK_EX);
    }
}
