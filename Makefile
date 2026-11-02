WORKTREE ?= $(CURDIR)
export WORKTREE

.PHONY: help clean-builds-preview clean-builds bump-version publish
help:
	@printf '%s\n' 'make clean-builds-preview [WORKTREE="path/to/checkout"]' \
		'make clean-builds [WORKTREE="path/to/checkout"] (cold Cargo rebuild next time)' \
		'make bump-version [BUMP=patch|minor|major | VERSION=X.Y.Z] (rewrite, commit, tag; never pushes)' \
		'make bump-version VERIFY=1 (run the local gate, build and lint before the release commit)' \
		'make publish [DRY_RUN=1] (publish the crate to crates.io with the token from .env)'

# Explicit human operation only; values pass as data, never shell source.
# The release commit does not run the local gate, build or lint; VERIFY=1 does.
bump-version: export TAURIMD_RELEASE_VERIFY = $(VERIFY)
bump-version: export TAURIMD_BUMP_VALUE = $(BUMP)
bump-version: export TAURIMD_VERSION_VALUE = $(VERSION)
bump-version: export TAURIMD_BUMP_ORIGIN = $(origin BUMP)
bump-version: export TAURIMD_VERSION_ORIGIN = $(origin VERSION)
bump-version:
	node scripts/release.mjs --make-inputs

# Publication to crates.io. The token comes from the environment or from the
# gitignored .env file; it is never written into the repository.
publish:
	node scripts/publish.mjs $(if $(DRY_RUN),--dry-run,)

# Cargo 1.97 profile clean ignores --target; build-dir scopes each recognized target.
# Keep target-dir at the tagged Cargo root, and suppress compiler-cache writes in preview.
clean-builds-preview clean-builds:
	@set -eu; \
	checkout=$$(cd "$$WORKTREE" && pwd -P); \
	test -f "$$checkout/src-tauri/Cargo.toml"; \
	test ! -L "$$checkout/src-tauri"; \
	output="$$checkout/src-tauri/target"; \
	test ! -L "$$output"; \
	if [ ! -d "$$output" ]; then printf '%s\n' 'No Cargo output directory.'; exit 0; fi; \
	targets=$$(rustc --print target-list); \
	for target in . $$targets; do \
		directory="$$output/$$target"; \
		if [ ! -d "$$directory" ] || [ -L "$$directory" ]; then continue; fi; \
		for profile in dev release; do \
			set --; \
			if [ '$@' = clean-builds-preview ]; then set -- --dry-run --verbose; fi; \
			printf '%s\n' "Cargo $$profile: $$directory"; \
			CARGO_CACHE_RUSTC_INFO=0 CARGO_BUILD_BUILD_DIR="$$directory" \
				cargo clean --frozen --manifest-path "$$checkout/src-tauri/Cargo.toml" \
				--target-dir "$$output" --profile "$$profile" "$$@"; \
		done; \
	done
