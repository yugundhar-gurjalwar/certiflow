.PHONY: up down reset test logs seed
up:        ## build and start everything (UI on http://localhost:8080)
	docker compose up --build -d
	@echo "UI: http://localhost:8080   WhatsApp stand-in: http://localhost:4010"
down:
	docker compose down
reset:     ## wipe all data (database, redis, certificates) and start clean
	docker compose down -v
test:      ## run the automated test-suite inside containers
	docker compose --profile test run --rm --build test
logs:
	docker compose logs -f api worker
seed:
	docker compose run --rm seed
