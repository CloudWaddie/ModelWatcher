#!/usr/bin/env python3
"""
LM Arena Model Scraper using Camoufox
Extracts the initialModels JSON from arena.ai page source
Reference: https://github.com/CloudWaddie/LMArenaBridge
"""
import asyncio
import json
import re
import sys

try:
    from camoufox.async_api import AsyncCamoufox
except ImportError as e:
    print(json.dumps({"error": f"camoufox not installed: {e}"}))
    sys.exit(0)


def extract_models_from_html(html):
    """Extract initialModels JSON from arena.ai HTML using bracket-count parsing."""
    idx = html.find('"initialModels":')
    if idx == -1:
        # Try escaped variant
        idx = html.find('\\"initialModels\\":')
        if idx == -1:
            return None
        # Adjust index to point to start of JSON object
        idx = html.find('[', idx)
    else:
        idx = html.find('[', idx)

    if idx == -1:
        return None

    # Parse the array by counting brackets, respecting strings
    bracket_count = 0
    in_string = False
    escape = False
    start = idx
    for i in range(start, len(html)):
        ch = html[i]
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"' and not in_string:
            in_string = True
        elif ch == '"' and in_string:
            in_string = False
        elif not in_string:
            if ch == '[':
                bracket_count += 1
            elif ch == ']':
                bracket_count -= 1
                if bracket_count == 0:
                    array_json = html[start:i+1]
                    try:
                        return json.loads(array_json)
                    except json.JSONDecodeError:
                        # Try unescaping first
                        try:
                            unescaped = array_json.encode().decode('unicode_escape')
                            return json.loads(unescaped)
                        except Exception:
                            return None
    return None


async def scrape_models():
    try:
        async with AsyncCamoufox(headless=True, main_world_eval=True) as browser:
            page = await browser.new_page(no_viewport=True)
            await page.goto("https://arena.ai/", wait_until="domcontentloaded", timeout=120000)

            # Wait for JS hydration and any Cloudflare challenge
            await asyncio.sleep(5)

            # Check for Cloudflare challenge
            try:
                title = await page.title()
                if "Just a moment" in title:
                    for _ in range(15):
                        await asyncio.sleep(2)
                        title = await page.title()
                        if "Just a moment" not in title:
                            break
            except Exception:
                pass

            page_body = await page.content()
            models = extract_models_from_html(page_body)

            if not models:
                print(json.dumps({"error": "Could not find initialModels in page"}))
                return

            print(json.dumps({"models": models}, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    asyncio.run(scrape_models())
