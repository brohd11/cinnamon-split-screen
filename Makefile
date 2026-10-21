.PHONY: test install install-ar uninstall uninstall-ar build

test:
	python3 tests/run.py

install:
	sh install.sh

install-ar:
	sh install.sh --ar

uninstall:
	sh uninstall.sh

uninstall-ar:
	sh uninstall.sh --ar

build:
	python3 tools/install.py build
	python3 tools/install.py build --ar
