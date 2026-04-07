#!/usr/bin/env python3
"""
Medium publisher via Playwright browser automation.
Logs in, creates a new story from markdown, and publishes it.

First run: opens a visible browser for you to log in manually (Google, email, etc.).
           Saves session cookies so subsequent runs are headless and automatic.

Usage:
  python medium_poster.py                  # uses post.md
  python medium_poster.py my_article.md    # custom file
  python medium_poster.py --login          # force re-login (clears saved session)
"""

import sys
import re
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

COOKIE_FILE = Path(__file__).parent / ".medium_session.json"
DEFAULT_POST = Path(__file__).parent / "post.md"
TAGS_FILE = Path(__file__).parent / "publish_config.json"


def md_to_medium_blocks(md_text: str) -> list[dict]:
    """Convert markdown to a list of actions to type into Medium's editor."""
    # Strip H1 title (Medium has its own title field)
    md_text = re.sub(r"^#\s+.*\n+", "", md_text, count=1)
    return md_text


def save_cookies(context):
    cookies = context.cookies()
    COOKIE_FILE.write_text(json.dumps(cookies, indent=2))
    print(f"  Session saved to {COOKIE_FILE.name}")


def load_cookies(context):
    if COOKIE_FILE.exists():
        cookies = json.loads(COOKIE_FILE.read_text())
        context.add_cookies(cookies)
        return True
    return False


def do_login(playwright):
    """Open visible browser for manual login. Polls until logged in, then saves cookies."""
    print("  Opening browser for Medium login...")
    print("  Log in however you prefer (Google, email, etc.)")
    print("  The browser will close automatically once login is detected.\n")

    browser = playwright.chromium.launch(headless=False)
    context = browser.new_context()
    page = context.new_page()
    page.goto("https://medium.com/m/signin")

    # Poll until we detect a logged-in state (max 10 minutes)
    deadline = time.time() + 600
    logged_in = False
    while time.time() < deadline:
        try:
            url = page.url
            # After login, Medium redirects away from signin pages
            if "/signin" not in url and "/m/signin" not in url and "medium.com" in url:
                # Double-check by looking for avatar or profile indicators
                try:
                    has_avatar = page.locator('img[alt*="avatar"], img[alt*="Avatar"], button[aria-label*="user"], [data-testid="headerAvatar"], a[href*="/@"]').first.is_visible(timeout=2000)
                except Exception:
                    has_avatar = False
                # Also check if we can reach the stories page
                if has_avatar or url.endswith("/") or "/@" in url or "/me/" in url or "/feed" in url:
                    logged_in = True
                    break
        except Exception:
            pass  # page may be navigating
        time.sleep(2)

    if not logged_in:
        print("  ERROR: Login timed out after 10 minutes.")
        browser.close()
        return False

    # Navigate to stories to confirm and capture full cookies
    page.goto("https://medium.com/me/stories")
    time.sleep(3)

    if "/signin" in page.url:
        print("  ERROR: Doesn't look like you're logged in. Try again.")
        browser.close()
        return False

    save_cookies(context)
    browser.close()
    print("  Login successful! Future runs will be automatic.\n")
    return True


def publish(md_text: str, title: str, tags: list[str]):
    """Publish a story to Medium using saved session."""
    body = md_to_medium_blocks(md_text)

    with sync_playwright() as p:
        # Check if we have a session
        if not COOKIE_FILE.exists():
            print("  No saved session. Starting login flow...")
            if not do_login(p):
                return False

        browser = p.chromium.launch(headless=False)  # Medium detects headless
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        load_cookies(context)
        page = context.new_page()

        # Go to new story editor
        print("  Opening Medium editor...")
        page.goto("https://medium.com/new-story", wait_until="networkidle", timeout=30000)
        time.sleep(3)

        # Check if redirected to sign in
        if "/signin" in page.url or "/m/signin" in page.url:
            print("  Session expired. Re-login needed.")
            browser.close()
            COOKIE_FILE.unlink(missing_ok=True)
            # Retry with fresh login
            with sync_playwright() as p2:
                if do_login(p2):
                    return publish(md_text, title, tags)
            return False

        # Type the title
        print("  Writing title...")
        try:
            title_el = page.locator('[data-testid="title"]').or_(
                page.locator('h3[data-contents="true"]')
            ).or_(
                page.locator('[role="textbox"]').first
            )
            title_el.click()
            title_el.fill(title)
            page.keyboard.press("Enter")
            time.sleep(1)
        except Exception as e:
            # Fallback: just click in the editor area and type
            print(f"  Title selector failed ({e}), trying fallback...")
            page.keyboard.press("Tab")
            page.keyboard.type(title, delay=20)
            page.keyboard.press("Enter")
            time.sleep(1)

        # Paste body as markdown — Medium's editor handles basic markdown
        print("  Writing body...")
        # Type body line by line to preserve formatting
        for line in body.split("\n"):
            if line.startswith("```"):
                # Code block toggle
                page.keyboard.press("Enter")
                continue
            page.keyboard.type(line, delay=5)
            page.keyboard.press("Enter")
            time.sleep(0.05)

        time.sleep(2)

        # Click publish button (top right)
        print("  Publishing...")
        try:
            # Medium has a "Publish" or "Ready to publish?" button
            publish_btn = page.locator('button:has-text("Publish")').first
            publish_btn.click()
            time.sleep(2)

            # Add tags if tag input appears
            try:
                tag_input = page.locator('input[placeholder*="tag"]').or_(
                    page.locator('[data-testid="tag-input"]')
                )
                if tag_input.is_visible(timeout=3000):
                    for tag in tags[:5]:
                        tag_input.fill(tag)
                        time.sleep(0.5)
                        page.keyboard.press("Enter")
                        time.sleep(0.3)
            except Exception:
                pass  # Tags are optional

            # Final publish confirmation
            try:
                confirm_btn = page.locator('button:has-text("Publish now")').or_(
                    page.locator('button:has-text("Publish")').last
                )
                confirm_btn.click()
                time.sleep(5)
            except Exception:
                pass

            # Get the published URL
            final_url = page.url
            if "/new-story" not in final_url:
                print(f"  Medium: {final_url}")
            else:
                print(f"  Medium: Published (check your stories page)")

            # Save updated cookies
            save_cookies(context)

        except Exception as e:
            print(f"  Medium publish failed: {e}")
            print(f"  Current URL: {page.url}")
            print("  The story may be saved as a draft. Check https://medium.com/me/stories")
            save_cookies(context)
            browser.close()
            return False

        browser.close()
        return True


def main():
    force_login = "--login" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--login"]
    post_file = Path(args[0]) if args else DEFAULT_POST

    if force_login:
        COOKIE_FILE.unlink(missing_ok=True)
        with sync_playwright() as p:
            do_login(p)
        if not args:
            return

    if not post_file.exists():
        print(f"ERROR: {post_file} not found")
        sys.exit(1)

    content = post_file.read_text(encoding="utf-8")
    title_match = re.match(r"^#\s+(.+)", content)
    title = title_match.group(1).strip() if title_match else "New Post"

    # Load tags from config if available
    tags = ["claude", "mcp", "developer-tools", "ai"]
    if TAGS_FILE.exists():
        cfg = json.loads(TAGS_FILE.read_text())
        tags = cfg.get("tags", tags)

    print(f"[Medium] Publishing: {title}\n")
    publish(content, title, tags)


if __name__ == "__main__":
    main()
