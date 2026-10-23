.PHONY: all deploy auth test run stop-server

all: deploy

auth:
	gcloud auth login
	gcloud auth application-default login

deploy:
	./deploy.sh

test:
	npm test

run:
	npm start

stop-server:
	./stop-server.sh
