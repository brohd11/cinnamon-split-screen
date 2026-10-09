.PHONY: test install uninstall

test:
	python3 tests/run.py

install:
	sh install.sh

uninstall:
	sh uninstall.sh
