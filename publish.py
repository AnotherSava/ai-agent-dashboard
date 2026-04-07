#!/usr/bin/env python3
"""
Fire-and-forget project announcer.
Posts to Dev.to, Hashnode, and Medium from a single markdown file.

Setup (one-time):
  pip install requests

  Then create publish_config.json next to this script (see publish_config.example.json).
"""

import json
import sys
import re
from pathlib import Path
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = Path(__file__).parent / "publish_config.json"
DEFAULT_POST = Path(__file__).parent / "post.md"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"ERROR: {CONFIG_PATH} not found.")
        print("Copy publish_config.example.json -> publish_config.json and fill in your keys.")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Dev.to  (REST API — easiest)
# ---------------------------------------------------------------------------

def post_to_devto(config: dict, title: str, body: str, tags: list[str], canonical_url: str | None):
    api_key = config.get("devto", {}).get("api_key")
    if not api_key:
        print("  SKIP: no devto.api_key in config")
        return

    body_clean = re.sub(r"^#\s+.*\n+", "", body, count=1)  # strip H1, Dev.to uses title field

    article = {
        "title": title,
        "body_markdown": body_clean,
        "published": True,
        "tags": tags[:4],
    }
    if canonical_url:
        article["canonical_url"] = canonical_url

    resp = requests.post(
        "https://dev.to/api/articles",
        headers={"api-key": api_key, "Content-Type": "application/json"},
        json={"article": article},
    )

    if resp.status_code == 201:
        print(f"  Dev.to: {resp.json().get('url', '(posted)')}")
    else:
        print(f"  Dev.to: FAILED {resp.status_code} — {resp.text[:300]}")


# ---------------------------------------------------------------------------
# Hashnode  (GraphQL API)
# ---------------------------------------------------------------------------

def post_to_hashnode(config: dict, title: str, body: str, tags: list[str], canonical_url: str | None):
    hn_cfg = config.get("hashnode", {})
    api_key = hn_cfg.get("api_key")
    publication_id = hn_cfg.get("publication_id")
    if not api_key or not publication_id:
        print("  SKIP: no hashnode.api_key or hashnode.publication_id in config")
        return

    body_clean = re.sub(r"^#\s+.*\n+", "", body, count=1)

    # Hashnode tag format: [{slug: "tag"}, ...]
    tag_objects = [{"slug": t.lower().replace(" ", "-"), "name": t} for t in tags[:5]]

    mutation = """
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post { url }
      }
    }
    """
    variables = {
        "input": {
            "title": title,
            "contentMarkdown": body_clean,
            "publicationId": publication_id,
            "tags": tag_objects,
        }
    }
    if canonical_url:
        variables["input"]["originalArticleURL"] = canonical_url

    resp = requests.post(
        "https://gql.hashnode.com/",
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json={"query": mutation, "variables": variables},
    )

    data = resp.json()
    if "errors" in data:
        print(f"  Hashnode: FAILED — {data['errors'][0].get('message', str(data['errors']))}")
    else:
        url = data.get("data", {}).get("publishPost", {}).get("post", {}).get("url", "(posted)")
        print(f"  Hashnode: {url}")


# ---------------------------------------------------------------------------
# Medium  (Playwright browser automation — no API tokens needed)
# ---------------------------------------------------------------------------

def post_to_medium(config: dict, title: str, body: str, tags: list[str], canonical_url: str | None):
    try:
        from medium_poster import publish
    except ImportError:
        print("  SKIP: medium_poster.py not found alongside this script")
        return

    if not Path(__file__).parent.joinpath(".medium_session.json").exists():
        print("  SKIP: No Medium session. Run 'python medium_poster.py --login' first.")
        return

    publish(body, title, tags)


# ---------------------------------------------------------------------------
# Hacker News (manual — no submit API)
# ---------------------------------------------------------------------------

def print_hn_instructions(title: str, repo_url: str | None):
    print("  No submit API. Post manually:")
    print(f"    https://news.ycombinator.com/submitlink")
    print(f"    Title: Show HN: {title}")
    if repo_url:
        print(f"    URL: {repo_url}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    post_file = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_POST

    if not post_file.exists():
        print(f"ERROR: Post file not found: {post_file}")
        sys.exit(1)

    config = load_config()
    content = post_file.read_text(encoding="utf-8")

    # Extract title from first H1
    title_match = re.match(r"^#\s+(.+)", content)
    title = title_match.group(1).strip() if title_match else "New Project Announcement"

    tags = config.get("tags", ["claude", "mcp", "electron", "opensource"])
    canonical_url = config.get("canonical_url")
    repo_url = config.get("repo_url")

    print(f"Publishing: {title}")
    print(f"  From: {post_file}\n")

    print("[Dev.to]")
    post_to_devto(config, title, content, tags, canonical_url)
    print()

    print("[Hashnode]")
    post_to_hashnode(config, title, content, tags, canonical_url)
    print()

    print("[Medium]")
    post_to_medium(config, title, content, tags, canonical_url)
    print()

    print("[Hacker News]")
    print_hn_instructions(title, repo_url)
    print()

    print("Done.")


if __name__ == "__main__":
    main()
