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


async def scrape_models():
    try:
        async with AsyncCamoufox(headless=True, main_world_eval=True) as browser:
            page = await browser.new_page()
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

            # Use the exact regex from LMArenaBridge
            match = re.search(r'{\\"initialModels\\":(\\[.*?\\]),\\"initialModel[A-Z]Id', page_body, re.DOTALL)
            if not match:
                print(json.dumps({"error": "Could not find initialModels in page"}))
                return

            models_json = match.group(1).encode().decode('unicode_escape')
            models = json.loads(models_json)

            print(json.dumps({"models": models}, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    asyncio.run(scrape_models())
