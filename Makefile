# Day-to-day commands in one place. Thin wrappers over the npm scripts, so package.json stays the
# source of truth and CI keeps calling npm directly.
#
#   make check                 everything CI gates: typecheck, tests, format, build
#   make test FILE=test/x.ts   one test file (or several, space-separated)
#   make bench-run SCRIPT=…    drive the bench with a Playwright script (the bench is served on its own)

.PHONY: help install build watch typecheck test format format-check check e2e shots hero bench bench-run dev package clean

SCRIPT ?=
ARGS ?=
FILE ?=

help:
	@grep -E '^[a-z0-9-]+:.*' Makefile | grep -v '^\.PHONY' | sed 's/:.*//' | tr '\n' ' '; echo

install:
	npm ci

build:
	node esbuild.mjs

watch:
	npm run watch

typecheck:
	npm run typecheck

test:
	npx vitest run $(FILE)

format:
	npm run format

format-check:
	npm run format:check

check: typecheck test format-check build

e2e:
	npm run test:e2e

# README images: the stills, then the animated hero.
shots: build
	node tools/bench/shots.mjs

hero: build
	node tools/bench/record.mjs

bench: build
	node tools/bench/serve.mjs

# Runs a Node script against the freshly built webview, e.g. an interaction or screenshot driver.
bench-run: build
	@test -n "$(SCRIPT)" || (echo 'usage: make bench-run SCRIPT=path/to/driver.mjs [ARGS=...]' && exit 2)
	node $(SCRIPT) $(ARGS)

# An Extension Development Host with its own save, so testing never touches your real game.
dev: build
	TOKENDEX_STATE_DIR="$(CURDIR)/.dev-state" code --new-window --extensionDevelopmentPath="$(CURDIR)"

package:
	npm run package

clean:
	rm -rf dist
