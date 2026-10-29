from pathlib import Path
PROJECT_NAME = ""

PROJECT_DIRS = [
    "app",
    "static",
]

PROJECT_FILES = [
    "requirements.txt",
    ".env.example",
    ".env",
    ".gitignore",
    ".dockerignore",
    "Dockerfile",
    "docker-compose.yml",
    "Caddyfile",
    "README.md",
    "setup.py",
    "app/__init__.py",
    "app/main.py",
    "app/s3.py",
    "static/scan.html",
    "static/scan.js",
]


def create_project() -> None:
    root = Path.cwd() / PROJECT_NAME
    root.mkdir(parents=True, exist_ok=True)

    for directory in PROJECT_DIRS:
        (root / directory).mkdir(parents=True, exist_ok=True)

    for file in PROJECT_FILES:
        path = root / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)

    print(f"Project scaffolded at: {root}")
    print(f"Directories: {len(PROJECT_DIRS)}, files: {len(PROJECT_FILES)}")
    print()
    print("Next: fill in each empty file with its content, then")
    print("      git add . && git commit -m 'initial structure'")
    print("      git push -u origin main")


if __name__ == "__main__":
    create_project()