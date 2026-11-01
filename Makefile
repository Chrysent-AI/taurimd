WORKTREE ?= $(CURDIR)
export WORKTREE

.PHONY: help clean-builds-preview clean-builds
help:
	@printf '%s\n' 'make clean-builds-preview [WORKTREE="path/to/checkout"]' \
		'make clean-builds [WORKTREE="path/to/checkout"] (cold Cargo rebuild next time)'

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
