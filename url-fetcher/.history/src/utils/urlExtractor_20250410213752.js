import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { isValidUrl, isValidUrlFormat } from "./urlValidator.js";
import { logger } from "./logger.js";
import { settings } from "../config/settings.js";

export async function getValidUrls(numUrls = settings.numberOfUrls) {
  const validUrls = new Set();
  const visited = new Set();
  const domains = new Set();

  // Function to extract domain from URL
  function getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  // Add this function at the top of the file
  function isNewDomain(url, existingUrls) {
    const domain = getDomain(url);
    return !Array.from(existingUrls).some(
      (existing) => getDomain(existing) === domain
    );
  }

  // Modify the extractUrlsFromPage function
  async function extractUrlsFromPage(url) {
    try {
      const response = await fetch(url, {
        headers: settings.headers,
        timeout: settings.timeout,
        redirect: "follow",
        follow: settings.maxRedirects,
      });

      if (!response.headers.get("content-type")?.includes("text/html")) {
        return [];
      }

      const html = await response.text();
      const dom = new JSDOM(html);
      const links = Array.from(dom.window.document.querySelectorAll("a"))
        .map((link) => {
          try {
            return new URL(link.href, url).toString();
          } catch {
            return null;
          }
        })
        .filter((link) => {
          if (!link || !link.startsWith("http")) return false;

          const domain = getDomain(link);
          if (!domain) return false;

          // Check domain level (avoid too generic URLs)
          if (domain.split(".").length < settings.minDomainLevel) return false;

          // Check excluded domains
          if (
            settings.excludedDomains.some((excluded) =>
              domain.includes(excluded)
            )
          ) {
            return false;
          }

          return true;
        });

      // Prioritize new domains we haven't seen before
      return [...new Set(links)].sort(() => Math.random() - 0.5);
    } catch (error) {
      logger.debug(`Failed to extract URLs from ${url}:`, error.message);
      return [];
    }
  }

  // Modify the crawl function to prioritize new domains
  async function crawl(startUrl) {
    if (validUrls.size >= numUrls || visited.has(startUrl)) {
      return;
    }

    visited.add(startUrl);

    if (await isValidUrl(startUrl)) {
      // Prioritize URLs from new domains
      if (isNewDomain(startUrl, validUrls)) {
        validUrls.add(startUrl);
        logger.info(`Found valid URL from new domain: ${startUrl}`);
      } else if (validUrls.size < numUrls) {
        // Only add URLs from existing domains if we haven't reached our target
        const domain = getDomain(startUrl);
        const urlsFromThisDomain = Array.from(validUrls).filter(
          (url) => getDomain(url) === domain
        ).length;

        if (urlsFromThisDomain < settings.maxUrlsPerDomain) {
          validUrls.add(startUrl);
        }
      }

      if (validUrls.size < numUrls) {
        const newUrls = await extractUrlsFromPage(startUrl);
        // Prioritize URLs from new domains
        const sortedUrls = newUrls.sort((a, b) =>
          isNewDomain(a, validUrls) ? -1 : isNewDomain(b, validUrls) ? 1 : 0
        );

        for (const url of sortedUrls) {
          if (!visited.has(url) && validUrls.size < numUrls) {
            await new Promise((resolve) =>
              setTimeout(resolve, settings.crawlDelay)
            );
            await crawl(url);
          }
        }
      }
    }
  }

  async function crawl(startUrl) {
    if (validUrls.size >= numUrls || visited.has(startUrl)) {
      return;
    }

    visited.add(startUrl);
    const domain = getDomain(startUrl);

    if (await isValidUrl(startUrl)) {
      // Check domain diversity
      const urlsFromThisDomain = Array.from(validUrls).filter(
        (url) => getDomain(url) === domain
      ).length;

      if (urlsFromThisDomain < settings.maxUrlsPerDomain) {
        validUrls.add(startUrl);
        domains.add(domain);
        logger.info(
          `Found valid URL (${validUrls.size}/${numUrls}) from domain ${domain}`
        );

        if (validUrls.size < numUrls) {
          const newUrls = await extractUrlsFromPage(startUrl);
          // Shuffle URLs for more randomness
          const shuffledUrls = newUrls.sort(() => Math.random() - 0.5);

          for (const url of shuffledUrls) {
            if (!visited.has(url) && validUrls.size < numUrls) {
              // Add delay to be respectful to servers
              await new Promise((resolve) =>
                setTimeout(resolve, settings.crawlDelay)
              );
              await crawl(url);
            }
          }
        }
      }
    }
  }

  // Expanded list of seed URLs for more diversity
  const diverseSeedUrls = [
    "https://news.ycombinator.com",
    "https://reddit.com",
    "https://medium.com",
    "https://dev.to",
    "https://techcrunch.com",
    "https://producthunt.com",
    "https://slashdot.org",
    "https://wired.com",
    "https://theverge.com",
    "https://mashable.com",
    ...settings.seedUrls,
  ];

  // Shuffle seed URLs for randomness
  const shuffledSeeds = diverseSeedUrls.sort(() => Math.random() - 0.5);

  // Crawl with concurrent promises but limit concurrency
  const concurrencyLimit = 5;
  for (let i = 0; i < shuffledSeeds.length; i += concurrencyLimit) {
    const batch = shuffledSeeds.slice(i, i + concurrencyLimit);
    await Promise.all(batch.map((url) => crawl(url)));

    if (validUrls.size >= numUrls) break;
  }

  return Array.from(validUrls).slice(0, numUrls);
}
