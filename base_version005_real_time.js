/**
 * =============================================================================
 * PNL (Profit & Loss) Modifier for Binance DEX
 * =============================================================================
 *
 * This script modifies displayed PNL and position size values on the Binance
 * trading interface. It multiplies the original values by a configurable
 * multiplier (default: 10,000x), replaces the displayed text, and protects
 * the modified values from being overwritten by Binance's own DOM updates.
 *
 * Key features:
 *   - Supports both desktop and mobile Binance layouts
 *   - macOS-specific timing optimizations
 *   - Debounced and throttled DOM updates for performance
 *   - MutationObserver-based protection to keep values modified
 *   - Automatic re-scanning on scroll, resize, and periodic intervals
 *   - Handles PNL elements (unrealized profit/loss) and Size elements
 *
 * The script generates random decimal places (00-99) to simulate
 * realistic-looking fractional values after multiplication.
 * =============================================================================
 */

!function () {
  "use strict";

  // ===========================================================================
  // CONFIGURATION CONSTANTS
  // ===========================================================================

  /** Multiplier applied to all PNL and size values (10,000x) */
  const MULTIPLIER = 1e6; // 10000

  /** Default debounce delay in ms for batching DOM updates (Windows) */
  const DEBOUNCE_MS = 50;

  /** How long (ms) before cached original values expire and get re-read */
  const CACHE_EXPIRY_MS = 3e4; // 30000 (30 seconds)

  /** Minimum interval (ms) between throttled scroll updates (Windows) */
  const THROTTLE_INTERVAL_MS = 16;

  /** Delay (ms) before performing a full DOM scan after scroll events */
  const UPDATE_DELAY_MS = 100;

  // ===========================================================================
  // DATA STORES
  // ===========================================================================

  /**
   * Maps to store original numeric values extracted from elements.
   * Keyed by DOM element reference. Used to detect real data changes
   * vs. our own modifications when re-observing elements.
   */

  /** Original PNL values for desktop elements (container -> original number) */
  const originalPnlValues = new Map();

  /** Tracks which truncate elements have been modified with new PNL text */
  const modifiedPnlElements = new WeakSet();

  /** Timestamps of when each PNL element was last modified (container -> timestamp) */
  const pnlModificationTimes = new Map();

  /** Tracks elements that have a PNL protection MutationObserver attached */
  const pnlProtectedElements = new WeakSet();

  /** Original size values for desktop elements (element -> original number) */
  const originalSizeValues = new Map();

  /** Tracks which size elements have been modified */
  const modifiedSizeElements = new WeakSet();

  /** Timestamps of when each size element was last modified */
  const sizeModificationTimes = new Map();

  /** Tracks size elements that have a protection MutationObserver attached */
  const sizeProtectedElements = new WeakSet();

  /** Original values for mobile size elements (element -> original number) */
  const originalMobileSizeValues = new Map();

  /** Tracks which mobile size elements have been modified */
  const modifiedMobileSizeElements = new WeakSet();

  /** Timestamps of when each mobile size element was last modified */
  const mobileSizeModificationTimes = new Map();

  /** Tracks mobile size elements with a protection MutationObserver */
  const mobileSizeProtectedElements = new WeakSet();

  /** Original values for mobile margin elements (element -> original number) */
  const originalMobileMarginValues = new Map();

  /** Tracks which mobile margin elements have been modified */
  const modifiedMobileMarginElements = new WeakSet();

  /** Timestamps of when each mobile margin element was last modified */
  const mobileMarginModificationTimes = new Map();

  /** Tracks mobile margin elements with a protection MutationObserver */
  const mobileMarginProtectedElements = new WeakSet();

  // ===========================================================================
  // ROI TRACKING DATA STORES (for real-time PNL calculation)
  // ===========================================================================

  /** Maps ROI element to its current ROI percentage value */
  const currentRoiValues = new Map();

  /** Maps position card container to its component elements {roi, margin, pnl, size} */
  const positionCardMapping = new Map();

  /** Tracks which ROI elements have observers attached */
  const roiProtectedElements = new WeakSet();

  /** Maps PNL element to its position card container (for reverse lookup) */
  const pnlToCardMapping = new WeakMap();

  /** Maps ROI element to its position card container (for reverse lookup) */
  const roiToCardMapping = new WeakMap();

  // ===========================================================================
  // STATE VARIABLES
  // ===========================================================================

  /**
   * Timeout IDs for debounced update batches.
   * Each element type (desktop PNL, mobile PNL, desktop size, mobile size,
   * full scan) has its own debounce timer to avoid redundant processing.
   */
  let desktopPnlDebounceTimer,
      mobilePnlDebounceTimer,
      desktopSizeDebounceTimer,
      mobileSizeDebounceTimer,
      mobileMarginDebounceTimer,
      fullScanDebounceTimer;

  /** Timestamp of the last throttled scroll handler execution */
  let lastThrottleTimestamp = 0;

  /**
   * Pending element sets — elements are queued here and processed
   * in batches after the debounce timer fires.
   */
  let pendingDesktopPnlElements = new Set();
  let pendingMobilePnlElements = new Set();
  let pendingDesktopSizeElements = new Set();
  let pendingMobileSizeElements = new Set();
  let pendingMobileMarginElements = new Set();

  // ===========================================================================
  // PLATFORM DETECTION (macOS vs Windows)
  // ===========================================================================

  /**
   * Detect if we're running on macOS. macOS has different rendering
   * characteristics, so we use longer debounce/throttle intervals.
   */
  const isMacOS =
    navigator.platform.toLowerCase().includes("mac") ||
    navigator.userAgent.toLowerCase().includes("mac") ||
    navigator.platform.toLowerCase().includes("darwin") ||
    /macintosh|mac os x/i.test(navigator.userAgent);

  /** Debounce delay: longer on macOS (75ms) for smoother rendering */
  const platformDebounceMs = isMacOS ? 75 : DEBOUNCE_MS;

  /** Startup polling interval: macOS waits longer between checks (250ms vs 150ms) */
  const platformStartupInterval = isMacOS ? 250 : 150;

  /** Throttle interval: macOS uses 25ms vs Windows 16ms */
  const platformThrottleMs = isMacOS ? 25 : THROTTLE_INTERVAL_MS;

  // ===========================================================================
  // CSS SELECTORS
  // ===========================================================================

  /**
   * Collection of CSS selectors used to find PNL, size, and container
   * elements in the Binance UI. Organized by element type and platform
   * (desktop vs mobile).
   */
  const SELECTORS = {

    // ---- Desktop PNL containers (usually flex containers with fixed width) ----
    pnlContainers: [
      'div[style*="flex: 1 0 140px"]',
      'div[style*="flex:1 0 140px"]',
      'div[style*="flex: 1"]',
      ".truncate-parent"
    ],

    // ---- Desktop size containers (flex containers ~100px wide) ----
    sizeContainers: [
      'div[style*="flex: 1 0 100px"]',
      'div[style*="flex:1 0 100px"]',
      'div[style*="flex:1"]',
      'div[style*="flex: 1 0 100"]',
      'div[style*="flex:1 0 100"]',
      '[style*="100px"][class*="text-"]',
      '[class*="text-Sell"][style*="flex"]',
      '[class*="text-Buy"][style*="flex"]',
      'div[style*="width: 100px"][style*="flex"]',
      '.text-Buy[style*="100px"]',
      '.text-Sell[style*="100px"]',
      '[style*="flex: 1"][class*="typography-caption2"]'
    ],

    // ---- Mobile PNL containers (position cards with padding) ----
    mobilePnlContainers: [
      "#POSITIONS .py-\\[16px\\]",
      '#POSITIONS div[class*="py-[16px]"]',
      ".py-\\[16px\\]",
      '[class*="py-[16px]"]'
    ],

    // ---- Mobile PNL value elements (text-TextSell / text-TextBuy with t-body2) ----
    mobilePnlElements: [
      ".flex.text-PrimaryText.t-body2.whitespace-nowrap.overflow-hidden.text-ellipsis.text-TextSell",
      ".flex.text-PrimaryText.t-body2.whitespace-nowrap.overflow-hidden.text-ellipsis.text-TextBuy",
      '.text-TextSell[class*="t-body2"]',
      '.text-TextBuy[class*="t-body2"]',
      '[class*="text-TextSell"][class*="t-body2"]',
      '[class*="text-TextBuy"][class*="t-body2"]',
      ".t-body2.text-TextSell",
      ".t-body2.text-TextBuy",
      ".text-TextSell.t-body2",
      ".text-TextBuy.t-body2",
      'div.text-TextSell[class*="t-body2"]',
      'div.text-TextBuy[class*="t-body2"]',
      '[class="flex text-PrimaryText t-body2 whitespace-nowrap overflow-hidden text-ellipsis text-TextSell"]',
      '[class="flex text-PrimaryText t-body2 whitespace-nowrap overflow-hidden text-ellipsis text-TextBuy"]'
    ],

    // ---- Mobile size containers (3-column grid in POSITIONS) ----
    mobileSizeContainers: [
      "#POSITIONS .grid.grid-cols-3.gap-\\[8px\\].mb-\\[8px\\]",
      '#POSITIONS div[class*="grid-cols-3"]',
      ".grid.grid-cols-3",
      '[class*="grid-cols-3"]'
    ],

    // ---- Mobile size value elements (numeric text-body2, not Sell/Buy colored) ----
    mobileSizeElements: [
      ".flex.text-PrimaryText.t-body2.whitespace-nowrap.overflow-hidden.text-ellipsis:not(.text-TextSell):not(.text-TextBuy)",
      "#POSITIONS .flex.flex-col.items-left .flex.text-PrimaryText.t-body2",
      ".grid-cols-3 .flex.flex-col.items-left .flex.text-PrimaryText.t-body2",
      ".flex.flex-col.items-left .t-body2:not(.text-TextSell):not(.text-TextBuy)",
      ".grid-cols-3 .flex.text-PrimaryText.t-body2:not(.text-TextSell):not(.text-TextBuy)",
      "#POSITIONS .grid .flex.text-PrimaryText.t-body2:not(.text-TextSell):not(.text-TextBuy)",
      "#POSITIONS .grid.grid-cols-3 .flex.flex-col.items-left .flex.text-PrimaryText.t-body2.whitespace-nowrap.overflow-hidden.text-ellipsis",
      ".grid.grid-cols-3.gap-\\[8px\\].mb-\\[8px\\] .flex.flex-col.items-left .flex.text-PrimaryText.t-body2.whitespace-nowrap.overflow-hidden.text-ellipsis"
    ],

    // ---- Mobile margin value elements (middle column in grid-cols-3, with SVG icon) ----
    mobileMarginElements: [
      "#POSITIONS .grid.grid-cols-3 .flex.flex-col:not(.items-left):not(.items-end) .flex.text-PrimaryText.t-body2",
      ".grid.grid-cols-3 .flex.flex-col:not(.items-left):not(.items-end) .t-body2",
      "#POSITIONS .grid-cols-3 > div:nth-child(2) .t-body2",
      ".grid-cols-3 .flex.flex-col:not([class*='items-']) .text-PrimaryText.t-body2"
    ],

    // ---- ROI (Return on Investment) elements - for real-time PNL calculation ----
    roiElements: [
      // Mobile ROI elements (percentage values, typically above PNL)
      ".t-caption1.text-TextSell",
      ".t-caption1.text-TextBuy",
      '[class*="t-caption1"][class*="text-TextSell"]',
      '[class*="t-caption1"][class*="text-TextBuy"]',
      ".text-TextSell.t-caption1",
      ".text-TextBuy.t-caption1",
      // Desktop ROI elements
      '[class*="typography-caption"][class*="text-Sell"]',
      '[class*="typography-caption"][class*="text-Buy"]',
      ".typography-caption2.text-Sell",
      ".typography-caption2.text-Buy"
    ],

    // ---- Position card containers (parent containers holding ROI, Margin, PNL, Size) ----
    positionCards: [
      "#POSITIONS .py-\\[16px\\]",
      '#POSITIONS div[class*="py-[16px]"]',
      ".py-\\[16px\\]",
      '[class*="py-[16px]"]',
      '[class*="position-card"]',
      '[data-position-card]'
    ],

    // ---- General scroll/position containers for mutation observation ----
    containers: [
      ".fixed-size-list",
      ".list-container",
      '[id*="position"]',
      "#POSITIONS",
      '[class*="position"]',
      'div[style*="overflow: auto"]',
      'div[style*="overflow-x: auto"]',
      'div[style*="overflow:auto"]',
      'div[style*="overflow-x:auto"]'
    ],

    // ---- Truncated text elements inside PNL containers ----
    truncateElements: [
      ".truncate",
      ".text-truncate",
      '[class*="truncate"]'
    ]
  };

  // ===========================================================================
  // UTILITY FUNCTIONS
  // ===========================================================================

  /**
   * Format a number for display: integer part with locale separators,
   * plus a 4-digit randomization split across last 2 integer digits and 2 decimal digits.
   * This makes the ×10,000 multiplication unnoticeable by avoiding the detectable
   * pattern where all values would end in "00.XX".
   *
   * Uses independent hash functions to eliminate recognizable patterns like 68.68, 17.17.
   *
   * @param {number} value - The numeric value to format (already multiplied)
   * @param {string} [elementType='pnl'] - Element type: 'pnl', 'margin', or 'size'
   * @returns {string} Formatted number string like "1,234,538.76"
   */
  function formatNumber(value, elementType = 'pnl') {
    const absValue = Math.abs(value);
    const intPortion = Math.floor(absValue);
    
    // Use different prime multipliers for different element types
    const primes = { 'pnl': 31, 'margin': 37, 'size': 41 };
    const primeA = primes[elementType] || 31;
    const primeB = primes[elementType] === 31 ? 53 : (primes[elementType] === 37 ? 59 : 67);
    
    // INDEPENDENT hash for integer replacement (last 2 digits)
    // Uses bit shifting and XOR to create non-linear mixing
    const intHash = (intPortion * primeA) ^ (intPortion >> 5);
    const intReplacement = (intHash * 17) % 100; // 00-99
    
    // INDEPENDENT hash for decimal part (completely different calculation)
    // Combines multiple operations to break correlation with intReplacement
    const decimalSeed = Math.floor(intPortion / 100); // Different portion of the value
    const decimalHash = ((decimalSeed * primeB) ^ (intPortion & 0xFF)) + (intPortion % 23);
    const decimalPart = ((decimalHash * 13) ^ (decimalHash >> 3)) % 100; // 00-99
    
    // Replace last 2 digits of integer with independent random
    const modifiedInteger = Math.floor(intPortion / 100) * 100 + intReplacement;
    
    // Format with locale separators and 2-digit decimal
    const decimalStr = decimalPart.toString().padStart(2, "0");
    return `${modifiedInteger.toLocaleString("en-US")}.${decimalStr}`;
  }

  /**
   * Validate that a PNL value change is legitimate (not our own modification
   * being read back). A "valid new value" must be:
   *   - At most 20% of the multiplied original value (i.e., it looks like
   *     a real un-multiplied value, not our already-multiplied one)
   *   - Greater than 0.01 (not essentially zero)
   *
   * @param {number} newValue - The newly observed numeric value
   * @param {number|undefined} storedOriginal - The stored original value
   * @returns {boolean} True if this looks like a genuine data update
   */
  function isValidPnlChange(newValue, storedOriginal) {
    if (!storedOriginal) return true;
    const multipliedOriginal = storedOriginal * MULTIPLIER;
    const absNew = Math.abs(newValue);
    return absNew <= 0.2 * Math.abs(multipliedOriginal) && absNew > 0.01;
  }

  /**
   * Validate that a size value change is legitimate (same logic as PNL).
   *
   * @param {number} newValue - The newly observed numeric value
   * @param {number|undefined} storedOriginal - The stored original value
   * @returns {boolean} True if this looks like a genuine data update
   */
  function isValidSizeChange(newValue, storedOriginal) {
    if (!storedOriginal) return true;
    const multipliedOriginal = storedOriginal * MULTIPLIER;
    const absNew = Math.abs(newValue);
    return absNew <= 0.2 * Math.abs(multipliedOriginal) && absNew > 0.01;
  }

  /**
   * Check if an element is visible within the browser viewport.
   * Only visible elements need to be processed (performance optimization).
   * macOS uses a slightly larger tolerance margin (10px vs 5px).
   *
   * @param {Element} element - DOM element to check
   * @returns {boolean} True if the element is visible in viewport
   */
  function isInViewport(element) {
    try {
      if (!element || !document.body.contains(element)) return false;

      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const tolerance = isMacOS ? 10 : 5;

      return (
        rect.top >= -tolerance &&
        rect.left >= -tolerance &&
        rect.bottom <= viewportHeight + tolerance &&
        rect.right <= viewportWidth + tolerance &&
        rect.width > 0 &&
        rect.height > 0
      );
    } catch (err) {
      console.warn("PNL Modifier: Error checking viewport:", err);
      return false;
    }
  }

  /**
   * Find the first child element matching any of the given CSS selectors.
   *
   * @param {Element} parent - Parent element to search within
   * @param {string[]} selectors - Array of CSS selector strings to try
   * @returns {Element|null} First matching child element, or null
   */
  function findFirstMatch(parent, selectors) {
    for (const selector of selectors) {
      try {
        const match = parent.querySelector(selector);
        if (match) return match;
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  // ===========================================================================
  // ROI-BASED PNL CALCULATION FUNCTIONS
  // ===========================================================================

  /**
   * Extract ROI percentage from text element.
   * Handles formats like: "+12.34%", "-5.67%", "12.34%"
   *
   * @param {Element} element - Element containing ROI text
   * @returns {number|null} ROI as decimal (12.34% → 0.1234) or null if invalid
   */
  function extractRoiValue(element) {
    try {
      const text = element.textContent.trim();
      const match = text.match(/([+-]?[\d,]+\.?\d*)\s*%/);
      
      if (match && match[1]) {
        const roiPercent = parseFloat(match[1].replace(/,/g, ""));
        if (!isNaN(roiPercent)) {
          return roiPercent / 100; // Convert percentage to decimal
        }
      }
      return null;
    } catch (err) {
      console.warn("PNL Modifier: Error extracting ROI:", err);
      return null;
    }
  }

  /**
   * Link position card elements together (ROI, Margin, PNL, Size).
   * This creates a mapping so when ROI changes, we can recalculate PNL.
   *
   * @param {Element} card - Position card container element
   */
  function linkPositionCard(card) {
    try {
      if (!card || !document.body.contains(card)) return;

      // Find ROI element (percentage with color, t-caption1)
      let roiElement = null;
      SELECTORS.roiElements.forEach(selector => {
        if (!roiElement) {
          const match = card.querySelector(selector);
          if (match && match.textContent.includes('%')) {
            roiElement = match;
          }
        }
      });

      // Find Margin element (in middle column of grid-cols-3)
      let marginElement = null;
      SELECTORS.mobileMarginElements.forEach(selector => {
        if (!marginElement) {
          const match = card.querySelector(selector);
          if (match) {
            const col = match.closest('.flex.flex-col');
            const label = col?.querySelector('[class*="t-caption1"]');
            if (label && label.textContent.includes("Margin")) {
              marginElement = match;
            }
          }
        }
      });

      // Find PNL element (colored t-body2, not in grid-cols-3)
      let pnlElement = null;
      SELECTORS.mobilePnlElements.forEach(selector => {
        if (!pnlElement) {
          const matches = card.querySelectorAll(selector);
          matches.forEach(match => {
            // PNL is typically outside grid-cols-3, or in a specific position
            if (!match.closest('.grid-cols-3')) {
              pnlElement = match;
            }
          });
        }
      });

      // Find Size element (in left column of grid-cols-3)
      let sizeElement = null;
      SELECTORS.mobileSizeElements.forEach(selector => {
        if (!sizeElement) {
          const match = card.querySelector(selector);
          if (match) {
            const col = match.closest('.flex.flex-col.items-left');
            const label = col?.querySelector('[class*="t-caption1"]');
            if (label && label.textContent.includes("Size")) {
              sizeElement = match;
            }
          }
        }
      });

      // Only create mapping if we found at least ROI and Margin and PNL
      if (roiElement && marginElement && pnlElement) {
        const cardData = {
          card: card,
          roi: roiElement,
          margin: marginElement,
          pnl: pnlElement,
          size: sizeElement
        };

        positionCardMapping.set(card, cardData);
        pnlToCardMapping.set(pnlElement, card);
        roiToCardMapping.set(roiElement, card);

        // Setup ROI observer
        setupRoiObserver(roiElement, card);

        console.log("PNL Modifier: Linked position card:", {
          hasROI: !!roiElement,
          hasMargin: !!marginElement,
          hasPNL: !!pnlElement,
          hasSize: !!sizeElement,
          roiText: roiElement?.textContent,
          marginText: marginElement?.textContent
        });
      }
    } catch (err) {
      console.warn("PNL Modifier: Error linking position card:", err);
    }
  }

  /**
   * Calculate PNL from ROI and Margin using the formula:
   * PNL = ROI × Margin
   * Then multiply by MULTIPLIER for display
   *
   * @param {number} roiDecimal - ROI as decimal (e.g., 0.1234 for 12.34%)
   * @param {number} margin - Margin value in USDT
   * @returns {number} Calculated PNL value (before multiplication)
   */
  function calculatePnlFromRoi(roiDecimal, margin) {
    return roiDecimal * margin;
  }

  /**
   * Update PNL display based on current ROI and Margin values.
   * This is called when ROI changes to recalculate PNL in real-time.
   * OPTIMIZED: Disables protection observer during update to eliminate delay.
   *
   * @param {Element} card - Position card container
   */
  function updatePnlFromRoi(card) {
    try {
      const cardData = positionCardMapping.get(card);
      if (!cardData) return;

      const { roi, margin, pnl } = cardData;
      if (!roi || !margin || !pnl) return;

      // OPTIMIZATION 1: Use Map cache first (faster than dataset access)
      let roiValue = currentRoiValues.get(roi);
      if (roiValue === undefined || isNaN(roiValue)) {
        roiValue = extractRoiValue(roi);
        if (roiValue !== null) {
          currentRoiValues.set(roi, roiValue);
          roi.dataset.originalRoi = roiValue.toString();
        } else {
          return;
        }
      }

      // OPTIMIZATION 2: Use Map cache first for margin (faster than dataset)
      let originalMargin = originalMobileMarginValues.get(margin);
      if (originalMargin === undefined) {
        // Fallback to dataset if Map doesn't have it
        if (margin.dataset.originalMargin) {
          originalMargin = parseFloat(margin.dataset.originalMargin);
          originalMobileMarginValues.set(margin, originalMargin);
        } else {
          // Cache miss - try to extract from current text as last resort
          let marginText = "";
          if (margin.firstChild && margin.firstChild.nodeType === 3) {
            marginText = margin.firstChild.nodeValue.trim();
          } else {
            marginText = margin.textContent.trim();
          }
          const marginMatch = marginText.match(/^([+-]?[\d,]+\.?\d*)$/);
          if (!marginMatch || !marginMatch[1]) {
            console.error("PNL Modifier: Cannot extract margin - cache miss and parse failed");
            return;
          }
          const marginValue = parseFloat(marginMatch[1].replace(/,/g, ""));
          // Detect if this is already multiplied (too large for margin)
          if (marginValue > 10000) {
            originalMargin = marginValue / MULTIPLIER;
            console.warn("PNL Modifier: Margin cache miss - dividing displayed value (may be inaccurate due to randomization)");
          } else {
            originalMargin = marginValue;
          }
          originalMobileMarginValues.set(margin, originalMargin);
          margin.dataset.originalMargin = originalMargin.toString();
        }
      }
      
      if (isNaN(originalMargin)) {
        console.error("PNL Modifier: Invalid original margin value");
        return;
      }

      // Calculate real PNL from ROI × Margin
      const calculatedPnl = calculatePnlFromRoi(roiValue, originalMargin);

      // Multiply for display
      const multipliedPnl = calculatedPnl * MULTIPLIER;

      // Format and update PNL display
      const sign = multipliedPnl > 0 ? "+" : "";
      const formattedPnl = `${sign}${formatNumber(Math.abs(multipliedPnl), 'pnl')}`;

      if (pnl.textContent !== formattedPnl) {
        // OPTIMIZATION 3: Temporarily disconnect protection observer to prevent conflict
        const protectionObserver = pnl._mobilePnlProtectionObserver;
        if (protectionObserver) {
          protectionObserver.disconnect();
        }
        
        // OPTIMIZATION 4: Mark element as being updated by ROI (flag for protection)
        pnl._updatingFromRoi = true;
        
        // Update text immediately (no delay)
        pnl.textContent = formattedPnl;
        
        // Update the cached original PNL value in both Map and dataset
        originalPnlValues.set(pnl, calculatedPnl);
        pnl.dataset.originalPnl = calculatedPnl.toString();
        modifiedPnlElements.add(pnl);
        pnlModificationTimes.set(pnl, Date.now());

        // OPTIMIZATION 5: Reconnect protection observer after microtask (immediate but async)
        Promise.resolve().then(() => {
          pnl._updatingFromRoi = false;
          if (protectionObserver) {
            try {
              protectionObserver.observe(pnl, {
                characterData: true,
                childList: true,
                subtree: true
              });
            } catch (e) {
              // Element may have been removed, ignore
            }
          }
        });

        console.log("PNL Modifier: Updated PNL from ROI (optimized):", {
          roi: `${(roiValue * 100).toFixed(2)}%`,
          margin: originalMargin.toFixed(2),
          calculatedPnl: calculatedPnl.toFixed(2),
          displayedPnl: formattedPnl
        });
      }
    } catch (err) {
      console.warn("PNL Modifier: Error updating PNL from ROI:", err);
    }
  }

  /**
   * Setup a MutationObserver to watch for ROI changes.
   * When ROI changes, recalculate PNL immediately with zero-delay optimization.
   *
   * @param {Element} roiElement - The ROI text element to observe
   * @param {Element} card - The position card container
   */
  function setupRoiObserver(roiElement, card) {
    if (roiProtectedElements.has(roiElement)) return;
    roiProtectedElements.add(roiElement);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "characterData" || mutation.type === "childList") {
          try {
            // OPTIMIZATION: Extract and cache ROI immediately, then trigger update
            const newRoi = extractRoiValue(roiElement);
            if (newRoi !== null) {
              const oldRoi = currentRoiValues.get(roiElement);
              
              // Only update if ROI actually changed
              if (oldRoi === undefined || Math.abs(newRoi - oldRoi) > 0.0001) {
                // Update Map immediately (faster than dataset)
                currentRoiValues.set(roiElement, newRoi);
                roiElement.dataset.originalRoi = newRoi.toString();
                
                // Trigger PNL update immediately (no delay, no RAF)
                updatePnlFromRoi(card);
              }
            }
          } catch (err) {
            console.warn("PNL Modifier: Error in ROI observer:", err);
          }
        }
      });
    });

    observer.observe(roiElement, {
      characterData: true,
      childList: true,
      subtree: true
    });

    roiElement._roiObserver = observer;

    // Store initial ROI value in both Map and dataset
    const initialRoi = extractRoiValue(roiElement);
    if (initialRoi !== null) {
      currentRoiValues.set(roiElement, initialRoi);
      roiElement.dataset.originalRoi = initialRoi.toString();
    }
  }

  // ===========================================================================
  // ELEMENT PROCESSING FUNCTIONS
  // ===========================================================================

  /**
   * Process a DESKTOP PNL container element.
   * Finds the truncated text child, extracts the USDT value, multiplies it,
   * and replaces the displayed text. Also sets up a protection observer.
   *
   * Expected format: "+123.45 USDT" → "+1,234,500.XX USDT"
   *
   * @param {Element} container - A flex container holding a PNL display
   */
  function processDesktopPnlElement(container) {
    try {
      // Skip if element is detached or hidden
      if (!document.body.contains(container) || null === container.offsetParent) return;

      // Find the truncated text element inside the container
      const truncateEl = findFirstMatch(container, SELECTORS.truncateElements);
      if (!truncateEl) return;

      const currentText = truncateEl.textContent.trim();
      const match = currentText.match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);

      if (match && match[1]) {
        let originalValue;

        // Use cached original value if available; otherwise parse and cache it
        if (originalPnlValues.has(container)) {
          originalValue = originalPnlValues.get(container);
        } else {
          originalValue = parseFloat(match[1].replace(/,/g, ""));
          originalPnlValues.set(container, originalValue);
          truncateEl.dataset.originalText = currentText;
          truncateEl.dataset.originalPnl = originalValue.toString();
          container.dataset.originalPnl = originalValue.toString();
        }

        // Calculate multiplied value and format
        const multipliedValue = originalValue * MULTIPLIER;
        const sign = multipliedValue > 0 ? "+" : multipliedValue < 0 ? "-" : "";
        const formattedText = `${sign}${formatNumber(Math.abs(multipliedValue), 'pnl')} USDT`;

        // Only update DOM if the text actually changed
        if (truncateEl.textContent !== formattedText) {
          truncateEl.textContent = formattedText;
          modifiedPnlElements.add(truncateEl);
          pnlProtectedElements.add(truncateEl);
          pnlModificationTimes.set(container, Date.now());
          setupDesktopPnlProtection(truncateEl, formattedText);
        }
      }
    } catch (err) {
      console.warn("PNL Modifier: Error processing PNL element:", err);
    }
  }

  /**
   * Process a MOBILE PNL element.
   * Mobile PNL elements show just the number (no "USDT" suffix) and are
   * identified by their CSS classes (text-TextSell / text-TextBuy + t-body2).
   *
   * NOW WITH ROI TRACKING: If this element is part of a position card with ROI,
   * the PNL will be calculated from ROI × Margin and updated in real-time.
   *
   * Expected format: "123.45" → "+1,234,500.XX"
   *
   * @param {Element} element - A text element displaying PNL on mobile
   */
  function processMobilePnlElement(element) {
    try {
      if (!document.body.contains(element) || null === element.offsetParent) return;

      // Check if this PNL element is part of a position card with ROI tracking
      const linkedCard = pnlToCardMapping.get(element);
      if (linkedCard) {
        // PNL is calculated from ROI, just trigger an update
        updatePnlFromRoi(linkedCard);
        return;
      }

      // Fallback: Original static multiplication method if no ROI tracking
      const currentText = element.textContent.trim();
      const match = currentText.match(/^([+-]?[\d,]+\.?\d*)$/);

      if (match && match[1]) {
        let originalValue;

        if (originalPnlValues.has(element)) {
          originalValue = originalPnlValues.get(element);
        } else {
          originalValue = parseFloat(match[1].replace(/,/g, ""));
          originalPnlValues.set(element, originalValue);
          element.dataset.originalText = currentText;
          element.dataset.originalPnl = originalValue.toString();

          if (isMacOS) {
            console.log("PNL Modifier (macOS): Found mobile PNL element (no ROI):", {
              text: currentText,
              originalValue: originalValue,
              classes: element.className,
              hasTextSell: element.classList.contains("text-TextSell"),
              hasTextBuy: element.classList.contains("text-TextBuy")
            });
          }
        }

        const multipliedValue = originalValue * MULTIPLIER;
        const sign = multipliedValue > 0 ? "+" : "";
        const formattedText = `${sign}${formatNumber(Math.abs(multipliedValue), 'pnl')}`;

        if (element.textContent !== formattedText) {
          element.textContent = formattedText;
          modifiedPnlElements.add(element);
          pnlProtectedElements.add(element);
          pnlModificationTimes.set(element, Date.now());
          setupMobilePnlProtection(element, formattedText);

          if (isMacOS) {
            console.log("PNL Modifier (macOS): Updated mobile PNL element (no ROI):", {
              original: currentText,
              modified: formattedText,
              multiplier: MULTIPLIER
            });
          }
        }
      }
    } catch (err) {
      console.warn("PNL Modifier: Error processing mobile PNL element:", err);
    }
  }

  /**
   * Process a MOBILE SIZE element.
   * Mobile size elements display position sizes in the 3-column grid.
   * They are plain numbers without "USDT" and are NOT colored as Sell/Buy.
   *
   * Expected format: "0.5" → "5,000.XX"
   *
   * @param {Element} element - A text element displaying position size on mobile
   */
  function processMobileSizeElement(element) {
    try {
      if (!document.body.contains(element) || null === element.offsetParent) return;

      const currentText = element.textContent.trim();
      const match = currentText.match(/^([+-]?[\d,]+\.?\d*)$/);

      if (match && match[1]) {
        let originalValue;

        if (originalMobileSizeValues.has(element)) {
          originalValue = originalMobileSizeValues.get(element);
        } else {
          originalValue = parseFloat(match[1].replace(/,/g, ""));
          originalMobileSizeValues.set(element, originalValue);
          element.dataset.originalText = currentText;
          element.dataset.originalSize = originalValue.toString();
          console.log("PNL Modifier: Found mobile size element:", {
            text: currentText,
            originalValue: originalValue,
            classes: element.className,
            isNegative: originalValue < 0
          });
        }

        const multipliedValue = originalValue * MULTIPLIER;
        const sign = multipliedValue < 0 ? "-" : "";
        const formattedText = `${sign}${formatNumber(Math.abs(multipliedValue), 'size')}`;

        if (element.textContent !== formattedText) {
          element.textContent = formattedText;
          modifiedMobileSizeElements.add(element);
          mobileSizeProtectedElements.add(element);
          mobileSizeModificationTimes.set(element, Date.now());
          setupMobileSizeProtection(element, formattedText);
          console.log("PNL Modifier: Updated mobile size element:", {
            original: currentText,
            modified: formattedText,
            wasNegative: originalValue < 0
          });
        }
      }
    } catch (err) {
      console.warn("PNL Modifier: Error processing mobile size element:", err);
    }
  }

  /**
   * Process a MOBILE MARGIN element.
   * Mobile margin elements display position margins in the 3-column grid.
   * They are plain numbers with an inline SVG icon that must be preserved.
   *
   * Expected format: "0.09" + SVG → "900.XX" + SVG
   *
   * @param {Element} element - A text element displaying position margin on mobile
   */
  function processMobileMarginElement(element) {
    try {
      if (!document.body.contains(element) || null === element.offsetParent) return;

      // Extract text content (will include SVG text, but we filter it)
      let textContent = "";
      if (element.firstChild && element.firstChild.nodeType === 3) {
        // Text node exists as first child
        textContent = element.firstChild.nodeValue.trim();
      } else {
        // Fallback: extract text but exclude SVG
        textContent = element.textContent.trim();
      }

      const match = textContent.match(/^([+-]?[\d,]+\.?\d*)$/);

      if (match && match[1]) {
        let originalValue;

        if (originalMobileMarginValues.has(element)) {
          originalValue = originalMobileMarginValues.get(element);
        } else {
          const parsed = parseFloat(match[1].replace(/,/g, ""));
          if (isNaN(parsed) || parsed === 0) return;

          // Validate this is a margin element by checking label
          const col = element.closest(".flex.flex-col");
          if (!col) return;
          
          const label = col.querySelector('[class*="t-caption1"]');
          if (!label || !label.textContent.includes("Margin")) return;

          originalValue = parsed;
          originalMobileMarginValues.set(element, originalValue);
          element.dataset.originalText = match[1];
          element.dataset.originalMargin = originalValue.toString();
        }

        const multipliedValue = originalValue * MULTIPLIER;
        const sign = multipliedValue < 0 ? "-" : "";
        const formattedText = `${sign}${formatNumber(Math.abs(multipliedValue), 'margin')}`;

        if (element.firstChild && element.firstChild.nodeType === 3) {
          // Update text node only, preserving SVG
          if (element.firstChild.nodeValue.trim() !== formattedText) {
            element.firstChild.nodeValue = formattedText;
            modifiedMobileMarginElements.add(element);
            mobileMarginProtectedElements.add(element);
            mobileMarginModificationTimes.set(element, Date.now());
            setupMobileMarginProtection(element, formattedText);
          }
        } else {
          // No text node found, create structure properly
          if (element.textContent.trim() !== formattedText) {
            const svg = element.querySelector("svg");
            element.textContent = formattedText;
            if (svg) element.appendChild(svg); // Re-append SVG after setting text
            modifiedMobileMarginElements.add(element);
            mobileMarginProtectedElements.add(element);
            mobileMarginModificationTimes.set(element, Date.now());
            setupMobileMarginProtection(element, formattedText);
          }
        }
      }
    } catch (err) {
      console.warn("PNL Modifier: Error processing mobile margin element:", err);
    }
  }

  /**
   * Process a DESKTOP SIZE element.
   * Desktop size elements display "XX.XX USDT" with a line break between
   * the number and "USDT". They are colored with text-Sell or text-Buy classes.
   *
   * Expected format: "0.5\nUSDT" → "5,000.XX\nUSDT"
   *
   * @param {Element} element - A flex element displaying position size on desktop
   */
  function processDesktopSizeElement(element) {
    try {
      if (!document.body.contains(element) || null === element.offsetParent) return;

      // Try to get text content, potentially from a child element
      let textContent = element.textContent.trim();
      if (!textContent.includes("USDT") && element.querySelector) {
        const child =
          element.querySelector('[class*="text-"]') ||
          element.querySelector('*[text*="USDT"]') ||
          element.querySelector("span, div");
        if (child) {
          textContent = child.textContent.trim();
        }
      }

      const match = textContent.match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);

      if (match && match[1]) {
        let originalValue;

        if (originalSizeValues.has(element)) {
          originalValue = originalSizeValues.get(element);
        } else {
          originalValue = parseFloat(match[1].replace(/,/g, ""));
          originalSizeValues.set(element, originalValue);
          element.dataset.originalText = textContent;
          element.dataset.originalSize = originalValue.toString();
        }

        const multipliedValue = originalValue * MULTIPLIER;

        // Determine sign: negative if the element has Sell class or value is negative
        const sign =
          element.classList.contains("text-Sell") ||
          element.className.includes("text-Sell") ||
          originalValue < 0
            ? "-"
            : "";

        const formattedNumber = formatNumber(Math.abs(multipliedValue), 'size');
        // The display format uses a line break between number and USDT
        const protectionText = `${sign}${formattedNumber}\nUSDT`;
        const normalizedCurrent = element.textContent.replace(/\s+/g, " ").trim();

        if (normalizedCurrent !== protectionText.replace(/[\n\r]/g, " ").trim()) {
          // Use innerHTML with <br> for the line break rendering
          try {
            element.innerHTML = `${sign}${formattedNumber}<br>USDT`;
          } catch (e) {
            element.textContent = `${sign}${formattedNumber} USDT`;
          }

          modifiedSizeElements.add(element);
          sizeProtectedElements.add(element);
          sizeModificationTimes.set(element, Date.now());
          setupDesktopSizeProtection(element, protectionText);

          // Verify the update stuck after a short delay
          setTimeout(() => {
            if (element.textContent && !element.textContent.includes(formattedNumber)) {
              console.warn("PNL Modifier: Size update verification failed, retrying...");
              try {
                element.innerHTML = `${sign}${formattedNumber}<br>USDT`;
              } catch (e) {
                element.textContent = `${sign}${formattedNumber} USDT`;
              }
            }
          }, 50);
        }
      }
    } catch (err) {
      console.warn("PNL Modifier: Error processing size element:", err);
    }
  }

  // ===========================================================================
  // PROTECTION OBSERVERS
  // ===========================================================================
  //
  // These functions attach MutationObservers to individual modified elements.
  // When Binance's JS tries to update the text back to the real value,
  // the observer intercepts the change and either:
  //   a) Recognizes it as a genuine data update → re-multiplies the new value
  //   b) Recognizes it as Binance resetting our change → restores our text
  //
  // ===========================================================================

  /**
   * Attach a protection observer to a desktop SIZE element.
   * Watches for text/child changes and re-applies the multiplied value.
   *
   * @param {Element} element - The size DOM element to protect
   * @param {string} expectedText - The text we set (with \n separator)
   */
  function setupDesktopSizeProtection(element, expectedText) {
    if (!sizeProtectedElements.has(element)) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type !== "characterData" && mutation.type !== "childList") return;

        try {
          // Read current text, trying child elements if needed
          let currentText = element.textContent.trim();
          if (!currentText.includes("USDT") && element.querySelector) {
            const child = element.querySelector("*");
            if (child) currentText = child.textContent.trim();
          }

          const currentMatch = currentText.match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
          if (!currentMatch || !currentMatch[1]) return;

          const currentNumber = parseFloat(currentMatch[1].replace(/,/g, ""));
          const expectedMatch = expectedText.match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
          if (!expectedMatch || !expectedMatch[1]) return;

          const expectedNumber = parseFloat(expectedMatch[1].replace(/,/g, ""));

          // If the number changed significantly, investigate
          if (Math.abs(currentNumber - expectedNumber) > 0.01) {
            // Check if this is a genuine new value from Binance
            if (isValidSizeChange(currentNumber, originalSizeValues.get(element))) {
              // Genuine update: store new original and re-multiply
              originalSizeValues.set(element, currentNumber);
              const newMultiplied = currentNumber * MULTIPLIER;
              const newSign =
                element.classList.contains("text-Sell") ||
                element.className.includes("text-Sell") ||
                currentNumber < 0
                  ? "-"
                  : "";
              const newFormatted = formatNumber(Math.abs(newMultiplied), 'size');
              const newProtectionText = `${newSign}${newFormatted}\nUSDT`;

              try {
                element.innerHTML = `${newSign}${newFormatted}<br>USDT`;
              } catch (e) {
                element.textContent = `${newSign}${newFormatted} USDT`;
              }

              // Reconnect with new expected text
              element._sizeProtectionObserver && element._sizeProtectionObserver.disconnect();
              setupDesktopSizeProtection(element, newProtectionText);
              return;
            }

            // Not a genuine update — Binance is resetting our text, so restore it
            try {
              if (expectedText.includes("\n")) {
                element.innerHTML = expectedText.replace("\n", "<br>");
              } else {
                element.innerHTML = expectedText;
              }
            } catch (e) {
              element.textContent = expectedText.replace("\n", " ");
            }

            // Double-check after a short delay
            setTimeout(() => {
              if (!element.textContent.trim().includes(expectedMatch[1])) {
                try {
                  element.innerHTML = expectedText.replace("\n", "<br>");
                } catch (e) {
                  element.textContent = expectedText.replace("\n", " ");
                }
              }
            }, 25);
          }
        } catch (err) {
          console.warn("PNL Modifier: Error in size protection:", err);
        }
      });
    });

    observer.observe(element, {
      characterData: true,
      childList: true,
      subtree: true
    });

    // Store reference so we can disconnect later if needed
    element._sizeProtectionObserver = observer;
  }

  /**
   * Attach a protection observer to a DESKTOP PNL truncate element.
   * Re-applies the multiplied PNL value if Binance resets it.
   *
   * @param {Element} truncateEl - The truncated text element showing PNL
   * @param {string} expectedText - The text we set (e.g., "+1,234.56 USDT")
   */
  function setupDesktopPnlProtection(truncateEl, expectedText) {
    if (!pnlProtectedElements.has(truncateEl)) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type !== "characterData" && mutation.type !== "childList") return;

        try {
          const currentMatch = truncateEl.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
          if (!currentMatch || !currentMatch[1]) return;

          const currentNumber = parseFloat(currentMatch[1].replace(/,/g, ""));
          const expectedMatch = expectedText.match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
          if (!expectedMatch || !expectedMatch[1]) return;

          const expectedNumber = parseFloat(expectedMatch[1].replace(/,/g, ""));

          if (Math.abs(currentNumber - expectedNumber) > 0.01) {
            // Find the parent container to look up the original value
            const container =
              truncateEl.closest('div[style*="flex: 1 0 140px"]') ||
              truncateEl.closest('div[style*="flex:1 0 140px"]');

            if (container && isValidPnlChange(currentNumber, originalPnlValues.get(container))) {
              // Genuine data update
              originalPnlValues.set(container, currentNumber);
              const newMultiplied = currentNumber * MULTIPLIER;
              const newSign = newMultiplied > 0 ? "+" : newMultiplied < 0 ? "-" : "";
              const newText = `${newSign}${formatNumber(Math.abs(newMultiplied), 'pnl')} USDT`;
              truncateEl.textContent = newText;

              // Reconnect protection with new expected text
              truncateEl._protectionObserver && truncateEl._protectionObserver.disconnect();
              setupDesktopPnlProtection(truncateEl, newText);
              return;
            }

            // Not genuine — restore our text
            truncateEl.textContent = expectedText;
          }
        } catch (err) {
          console.warn("PNL Modifier: Error in PNL protection:", err);
        }
      });
    });

    observer.observe(truncateEl, {
      characterData: true,
      childList: true,
      subtree: true
    });

    truncateEl._protectionObserver = observer;
  }

  /**
   * Attach a protection observer to a MOBILE PNL element.
   * Similar to desktop PNL protection but handles the mobile format
   * (no "USDT" suffix, just the number).
   *
   * @param {Element} element - The mobile PNL text element
   * @param {string} expectedText - The text we set (e.g., "+1,234.56")
   */
  function setupMobilePnlProtection(element, expectedText) {
    if (!pnlProtectedElements.has(element)) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type !== "characterData" && mutation.type !== "childList") return;

        // OPTIMIZATION: Skip protection if element is being updated by ROI
        if (element._updatingFromRoi) return;

        try {
          const currentMatch = element.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
          if (!currentMatch || !currentMatch[1]) return;

          const currentNumber = parseFloat(currentMatch[1].replace(/,/g, ""));
          const expectedMatch = expectedText.match(/^([+-]?[\d,]+\.?\d*)$/);
          if (!expectedMatch || !expectedMatch[1]) return;

          const expectedNumber = parseFloat(expectedMatch[1].replace(/,/g, ""));

          if (Math.abs(currentNumber - expectedNumber) > 0.01) {
            if (isValidPnlChange(currentNumber, originalPnlValues.get(element))) {
              // Genuine update: re-multiply
              originalPnlValues.set(element, currentNumber);
              const newMultiplied = currentNumber * MULTIPLIER;
              const newSign = newMultiplied > 0 ? "+" : newMultiplied < 0 ? "-" : "";
              const newText = `${newSign}${formatNumber(Math.abs(newMultiplied), 'pnl')}`;
              element.textContent = newText;

              element._mobilePnlProtectionObserver && element._mobilePnlProtectionObserver.disconnect();
              setupMobilePnlProtection(element, newText);
              return;
            }

            // Not genuine — restore
            element.textContent = expectedText;
          }
        } catch (err) {
          console.warn("PNL Modifier: Error in mobile PNL protection:", err);
        }
      });
    });

    observer.observe(element, {
      characterData: true,
      childList: true,
      subtree: true
    });

    element._mobilePnlProtectionObserver = observer;
  }

  /**
   * Attach a protection observer to a MOBILE SIZE element.
   *
   * @param {Element} element - The mobile size text element
   * @param {string} expectedText - The text we set (e.g., "5,000.12")
   */
  function setupMobileSizeProtection(element, expectedText) {
    if (!mobileSizeProtectedElements.has(element)) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type !== "characterData" && mutation.type !== "childList") return;

        try {
          const currentMatch = element.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
          if (!currentMatch || !currentMatch[1]) return;

          const currentNumber = parseFloat(currentMatch[1].replace(/,/g, ""));
          const expectedMatch = expectedText.match(/^([+-]?[\d,]+\.?\d*)$/);
          if (!expectedMatch || !expectedMatch[1]) return;

          const expectedNumber = parseFloat(expectedMatch[1].replace(/,/g, ""));

          if (Math.abs(currentNumber - expectedNumber) > 0.01) {
            if (isValidSizeChange(currentNumber, originalMobileSizeValues.get(element))) {
              // Genuine update: re-multiply
              originalMobileSizeValues.set(element, currentNumber);
              const newMultiplied = currentNumber * MULTIPLIER;
              const newSign = newMultiplied < 0 ? "-" : "";
              const newText = `${newSign}${formatNumber(Math.abs(newMultiplied), 'size')}`;
              element.textContent = newText;

              element._mobileSizeProtectionObserver && element._mobileSizeProtectionObserver.disconnect();
              setupMobileSizeProtection(element, newText);
              return;
            }

            // Not genuine — restore
            element.textContent = expectedText;
          }
        } catch (err) {
          console.warn("PNL Modifier: Error in mobile size protection:", err);
        }
      });
    });

    observer.observe(element, {
      characterData: true,
      childList: true,
      subtree: true
    });

    element._mobileSizeProtectionObserver = observer;
  }

  /**
   * Attach a protection observer to a MOBILE MARGIN element.
   * Handles mixed content (text node + SVG icon element).
   *
   * @param {Element} element - The mobile margin text element
   * @param {string} expectedText - The text we set (e.g., "900.12")
   */
  function setupMobileMarginProtection(element, expectedText) {
    if (!mobileMarginProtectedElements.has(element)) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        try {
          // Extract current text from text node
          let currentText = "";
          if (element.firstChild && element.firstChild.nodeType === 3) {
            currentText = element.firstChild.nodeValue.trim();
          } else {
            currentText = element.textContent.trim();
          }

          // If text doesn't match our format, Binance may have reset it
          if (currentText !== expectedText && currentText.match(/^[\d,]+\.?\d*$/)) {
            const newNumber = parseFloat(currentText.replace(/,/g, ""));
            const storedOriginal = originalMobileMarginValues.get(element);

            if (storedOriginal && isValidSizeChange(newNumber, storedOriginal)) {
              // Valid data update from Binance
              originalMobileMarginValues.set(element, newNumber);
              const multipliedValue = newNumber * MULTIPLIER;
              const sign = multipliedValue < 0 ? "-" : "";
              const newText = `${sign}${formatNumber(Math.abs(multipliedValue), 'margin')}`;
              
              if (element.firstChild && element.firstChild.nodeType === 3) {
                element.firstChild.nodeValue = newText;
              } else {
                const svg = element.querySelector("svg");
                element.textContent = newText;
                if (svg) element.appendChild(svg);
              }
              
              mobileMarginModificationTimes.set(element, Date.now());
            } else {
              // Binance reset our value, restore it
              if (element.firstChild && element.firstChild.nodeType === 3) {
                element.firstChild.nodeValue = expectedText;
              } else {
                const svg = element.querySelector("svg");
                element.textContent = expectedText;
                if (svg) element.appendChild(svg);
              }
            }
          }
        } catch (err) {
          console.warn("PNL Modifier: Error in mobile margin protection:", err);
        }
      });
    });

    observer.observe(element, {
      characterData: true,
      childList: true,
      subtree: true
    });

    element._mobileMarginProtectionObserver = observer;
  }

  // ===========================================================================
  // THROTTLED SCROLL / WHEEL HANDLER
  // ===========================================================================

  /**
   * Handle scroll and wheel events with throttling.
   * Triggers a debounced full DOM scan so that newly scrolled-into-view
   * elements get their values modified.
   */
  function handleScrollEvent() {
    const now = Date.now();

    // Throttle: skip if called too soon after the last execution
    if (now - lastThrottleTimestamp < (isMacOS ? platformThrottleMs : THROTTLE_INTERVAL_MS)) {
      return;
    }
    lastThrottleTimestamp = now;

    // Debounce: schedule a full scan after scrolling settles
    clearTimeout(fullScanDebounceTimer);
    fullScanDebounceTimer = setTimeout(() => {
      performFullScan();
    }, isMacOS ? 1.5 * UPDATE_DELAY_MS : UPDATE_DELAY_MS);
  }

  // ===========================================================================
  // DEBOUNCED QUEUE PROCESSORS
  // ===========================================================================
  //
  // Elements are added to pending sets, then processed in batches after
  // a platform-specific debounce delay. Only visible elements are processed.
  //

  /**
   * Queue a desktop PNL container for processing.
   * @param {Element} element - The PNL container element
   */
  function queueDesktopPnlUpdate(element) {
    pendingDesktopPnlElements.add(element);
    clearTimeout(desktopPnlDebounceTimer);
    desktopPnlDebounceTimer = setTimeout(() => {
      Array.from(pendingDesktopPnlElements)
        .filter(isInViewport)
        .forEach(processDesktopPnlElement);
      pendingDesktopPnlElements.clear();
    }, isMacOS ? platformDebounceMs : DEBOUNCE_MS);
  }

  /**
   * Queue a mobile PNL element for processing.
   * @param {Element} element - The mobile PNL text element
   */
  function queueMobilePnlUpdate(element) {
    pendingMobilePnlElements.add(element);
    clearTimeout(mobilePnlDebounceTimer);
    mobilePnlDebounceTimer = setTimeout(() => {
      Array.from(pendingMobilePnlElements)
        .filter(isInViewport)
        .forEach(processMobilePnlElement);
      pendingMobilePnlElements.clear();
    }, isMacOS ? platformDebounceMs : DEBOUNCE_MS);
  }

  /**
   * Queue a mobile size element for processing.
   * @param {Element} element - The mobile size text element
   */
  function queueMobileSizeUpdate(element) {
    pendingMobileSizeElements.add(element);
    clearTimeout(mobileSizeDebounceTimer);
    mobileSizeDebounceTimer = setTimeout(() => {
      Array.from(pendingMobileSizeElements)
        .filter(isInViewport)
        .forEach(processMobileSizeElement);
      pendingMobileSizeElements.clear();
    }, isMacOS ? platformDebounceMs : DEBOUNCE_MS);
  }

  /**
   * Queue a desktop size element for processing.
   * @param {Element} element - The desktop size element
   */
  function queueDesktopSizeUpdate(element) {
    pendingDesktopSizeElements.add(element);
    clearTimeout(desktopSizeDebounceTimer);
    desktopSizeDebounceTimer = setTimeout(() => {
      Array.from(pendingDesktopSizeElements)
        .filter(isInViewport)
        .forEach(processDesktopSizeElement);
      pendingDesktopSizeElements.clear();
    }, isMacOS ? platformDebounceMs : DEBOUNCE_MS);
  }

  /**
   * Queue a mobile margin element for processing.
   * @param {Element} element - The mobile margin text element
   */
  function queueMobileMarginUpdate(element) {
    pendingMobileMarginElements.add(element);
    clearTimeout(mobileMarginDebounceTimer);
    mobileMarginDebounceTimer = setTimeout(() => {
      Array.from(pendingMobileMarginElements)
        .filter(isInViewport)
        .forEach(processMobileMarginElement);
      pendingMobileMarginElements.clear();
    }, isMacOS ? platformDebounceMs : DEBOUNCE_MS);
  }

  // ===========================================================================
  // MUTATION OBSERVER CALLBACK
  // ===========================================================================

  /**
   * Main MutationObserver callback. Called whenever the observed DOM tree changes.
   * Categorizes mutations and queues the appropriate elements for processing.
   *
   * Handles:
   *   1. New nodes added (childList mutations with addedNodes)
   *      - Scans new nodes for PNL and size elements to modify
   *   2. Text content changes (characterData mutations)
   *      - Detects Binance updating values and re-applies our modifications
   *
   * @param {MutationRecord[]} mutations - Array of DOM mutation records
   */
  function handleMutations(mutations) {
    // Collect elements that need processing, separated by type
    const desktopPnlToProcess = new Set();
    const desktopSizeToProcess = new Set();
    const mobilePnlToProcess = new Set();
    const mobileSizeToProcess = new Set();
    const mobileMarginToProcess = new Set();

    try {
      for (const mutation of mutations) {

        // =================================================================
        // CASE 1: New nodes added to the DOM
        // =================================================================
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return; // Only process element nodes

            // --- NEW: Check for position cards to link ROI → Margin → PNL ---
            SELECTORS.positionCards.forEach((selector) => {
              try {
                // Search within the new node's subtree
                const matches = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                matches.forEach((card) => {
                  if (!positionCardMapping.has(card)) {
                    linkPositionCard(card);
                  }
                });

                // Check if the node itself is a position card
                if (node.matches && node.matches(selector) && !positionCardMapping.has(node)) {
                  linkPositionCard(node);
                }
              } catch (e) { /* selector may not be valid for this node */ }
            });

            // --- Check for desktop PNL elements ---
            SELECTORS.pnlContainers.forEach((selector) => {
              try {
                // Search within the new node's subtree
                const matches = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                matches.forEach((match) => {
                  const truncateEl = findFirstMatch(match, SELECTORS.truncateElements);
                  if (truncateEl && truncateEl.textContent.includes("USDT")) {
                    desktopPnlToProcess.add(match);
                  }
                });

                // Check if the node itself matches
                if (node.matches && node.matches(selector)) {
                  const truncateEl = findFirstMatch(node, SELECTORS.truncateElements);
                  if (truncateEl && truncateEl.textContent.includes("USDT")) {
                    desktopPnlToProcess.add(node);
                  }
                }
              } catch (e) { /* selector may not be valid for this node */ }
            });

            // --- Check for mobile PNL elements ---
            SELECTORS.mobilePnlElements.forEach((selector) => {
              try {
                const matches = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                matches.forEach((match) => {
                  if (
                    match.textContent.trim().match(/^[+-]?[\d,]+\.?\d*$/) &&
                    (match.classList.contains("text-TextSell") || match.classList.contains("text-TextBuy"))
                  ) {
                    // Verify this is in an "Unrealized PNL" context
                    const parentRow = match.closest(".flex.justify-between.mb-\\[8px\\]") ||
                                      match.closest(".flex.justify-between");
                    if (parentRow) {
                      const label = parentRow.querySelector('[class*="t-caption1"]');
                      if (label && label.textContent.includes("Unrealized PNL")) {
                        mobilePnlToProcess.add(match);
                      }
                    }
                  }
                });

                // Check the node itself
                if (node.matches && node.matches(selector)) {
                  if (
                    node.textContent.trim().match(/^[+-]?[\d,]+\.?\d*$/) &&
                    (node.classList.contains("text-TextSell") || node.classList.contains("text-TextBuy"))
                  ) {
                    const parentRow = node.closest(".flex.justify-between.mb-\\[8px\\]") ||
                                      node.closest(".flex.justify-between");
                    if (parentRow) {
                      const label = parentRow.querySelector('[class*="t-caption1"]');
                      if (label && label.textContent.includes("Unrealized PNL")) {
                        mobilePnlToProcess.add(node);
                      }
                    }
                  }
                }
              } catch (e) { /* selector may fail */ }
            });

            // --- Check for mobile SIZE elements ---
            SELECTORS.mobileSizeElements.forEach((selector) => {
              try {
                const matches = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                matches.forEach((match) => {
                  const text = match.textContent.trim();
                  if (
                    text.match(/^[+-]?[\d,]+\.?\d*$/) &&
                    !match.classList.contains("text-TextSell") &&
                    !match.classList.contains("text-TextBuy") &&
                    match.classList.contains("t-body2")
                  ) {
                    if (match.closest(".grid.grid-cols-3")) {
                      const col = match.closest(".flex.flex-col.items-left") ||
                                  match.closest(".flex.flex-col");
                      if (col) {
                        const label = col.querySelector('[class*="t-caption1"]');
                        if (label && label.textContent.includes("Size")) {
                          mobileSizeToProcess.add(match);
                          console.log("PNL Modifier: Found mobile size element (node added):", {
                            text: text,
                            selector: selector,
                            hasLabel: !!label
                          });
                        } else if (label && label.textContent.includes("Margin")) {
                          mobileMarginToProcess.add(match);
                          console.log("PNL Modifier: Found mobile margin element (node added):", {
                            text: text,
                            selector: selector,
                            hasLabel: !!label
                          });
                        }
                      }
                    }
                  }
                });

                // Check the node itself
                if (node.matches && node.matches(selector)) {
                  const text = node.textContent.trim();
                  if (
                    text.match(/^[+-]?[\d,]+\.?\d*$/) &&
                    !node.classList.contains("text-TextSell") &&
                    !node.classList.contains("text-TextBuy") &&
                    node.classList.contains("t-body2")
                  ) {
                    if (node.closest(".grid.grid-cols-3")) {
                      const col = node.closest(".flex.flex-col.items-left") ||
                                  node.closest(".flex.flex-col");
                      if (col) {
                        const label = col.querySelector('[class*="t-caption1"]');
                        if (label && label.textContent.includes("Size")) {
                          mobileSizeToProcess.add(node);
                          console.log("PNL Modifier: Found mobile size element (node itself):", {
                            text: text,
                            selector: selector,
                            hasLabel: !!label
                          });
                        } else if (label && label.textContent.includes("Margin")) {
                          mobileMarginToProcess.add(node);
                          console.log("PNL Modifier: Found mobile margin element (node itself):", {
                            text: text,
                            selector: selector,
                            hasLabel: !!label
                          });
                        }
                      }
                    }
                  }
                }
              } catch (e) { /* selector may fail */ }
            });

            // --- Check for desktop SIZE elements ---
            SELECTORS.sizeContainers.forEach((selector) => {
              try {
                const matches = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                matches.forEach((match) => {
                  const hasUSDT = match.textContent.includes("USDT");
                  const isSellOrBuy =
                    match.classList.contains("text-Sell") ||
                    match.classList.contains("text-Buy") ||
                    match.className.includes("text-Sell") ||
                    match.className.includes("text-Buy");
                  const hasFlex100 =
                    match.style.flex &&
                    (match.style.flex.includes("100px") || match.style.flex.includes("100"));
                  if (hasUSDT && (isSellOrBuy || hasFlex100)) {
                    desktopSizeToProcess.add(match);
                  }
                });

                // Check the node itself
                if (node.matches && node.matches(selector)) {
                  const hasUSDT = node.textContent.includes("USDT");
                  const isSellOrBuy =
                    node.classList.contains("text-Sell") ||
                    node.classList.contains("text-Buy") ||
                    node.className.includes("text-Sell") ||
                    node.className.includes("text-Buy");
                  const hasFlex100 =
                    node.style.flex &&
                    (node.style.flex.includes("100px") || node.style.flex.includes("100"));
                  if (hasUSDT && (isSellOrBuy || hasFlex100)) {
                    desktopSizeToProcess.add(node);
                  }
                }
              } catch (e) { /* selector issue */ }
            });
          });
        }

        // =================================================================
        // CASE 2: TEXT CHANGES — Desktop PNL (truncate class elements)
        // =================================================================
        if (
          (mutation.type === "characterData" || mutation.type === "childList") &&
          mutation.target.classList &&
          mutation.target.classList.contains("truncate")
        ) {
          let targetEl = mutation.target;
          if (targetEl.nodeType !== 1) targetEl = targetEl.parentElement;

          if (targetEl && targetEl.closest) {
            const container =
              targetEl.closest('div[style*="flex: 1 0 140px"]') ||
              targetEl.closest('div[style*="flex:1 0 140px"]');

            if (container) {
              const truncateEl = findFirstMatch(container, SELECTORS.truncateElements);
              if (truncateEl && truncateEl.textContent.includes("USDT")) {
                const match = truncateEl.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
                if (match && match[1]) {
                  const newValue = parseFloat(match[1].replace(/,/g, ""));
                  if (isValidPnlChange(newValue, originalPnlValues.get(container))) {
                    originalPnlValues.set(container, newValue);
                    desktopPnlToProcess.add(container);
                  }
                }
              }
            }
          }
        }

        // =================================================================
        // CASE 3: TEXT CHANGES — Mobile PNL elements
        // =================================================================
        if (mutation.type === "characterData" || mutation.type === "childList") {
          let targetEl = mutation.target;
          if (targetEl.nodeType !== 1) targetEl = targetEl.parentElement;

          if (
            targetEl &&
            targetEl.classList &&
            (targetEl.classList.contains("text-TextSell") || targetEl.classList.contains("text-TextBuy")) &&
            targetEl.classList.contains("t-body2")
          ) {
            const match = targetEl.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
            if (match && match[1]) {
              const parentRow =
                targetEl.closest(".flex.justify-between.mb-\\[8px\\]") ||
                targetEl.closest(".flex.justify-between");
              if (parentRow) {
                const label = parentRow.querySelector('[class*="t-caption1"]');
                if (label && label.textContent.includes("Unrealized PNL")) {
                  const newValue = parseFloat(match[1].replace(/,/g, ""));
                  if (isValidPnlChange(newValue, originalPnlValues.get(targetEl))) {
                    originalPnlValues.set(targetEl, newValue);
                    mobilePnlToProcess.add(targetEl);
                  }
                }
              }
            }
          }
        }

        // =================================================================
        // CASE 4: TEXT CHANGES — Mobile SIZE elements
        // =================================================================
        if (mutation.type === "characterData" || mutation.type === "childList") {
          let targetEl = mutation.target;
          if (targetEl.nodeType !== 1) targetEl = targetEl.parentElement;

          if (
            targetEl &&
            targetEl.classList &&
            targetEl.classList.contains("t-body2") &&
            !targetEl.classList.contains("text-TextSell") &&
            !targetEl.classList.contains("text-TextBuy")
          ) {
            const match = targetEl.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
            if (match && match[1]) {
              const gridContainer = targetEl.closest(".grid.grid-cols-3");
              const label = gridContainer?.querySelector('[class*="t-caption1"]');
              if (label && label.textContent.includes("Size")) {
                const newValue = parseFloat(match[1].replace(/,/g, ""));
                if (isValidSizeChange(newValue, originalMobileSizeValues.get(targetEl))) {
                  originalMobileSizeValues.set(targetEl, newValue);
                  mobileSizeToProcess.add(targetEl);
                }
              }
            }
          }
        }

        // =================================================================
        // CASE 5: TEXT CHANGES — Desktop SIZE elements (flex-based)
        // =================================================================
        if (mutation.type === "characterData" || mutation.type === "childList") {
          let targetEl = mutation.target;
          if (targetEl.nodeType !== 1) targetEl = targetEl.parentElement;

          // Direct style check on the element
          if (targetEl && targetEl.style) {
            const flexValue = targetEl.style.flex;
            const hasFlex100 =
              flexValue === "1 0 100px" ||
              flexValue === "1 0 100px" ||
              flexValue === "1 0 100" ||
              flexValue === "1 0 100px" ||
              flexValue.includes("100px") ||
              flexValue.includes("100");
            const hasUSDT = targetEl.textContent.includes("USDT");
            const isSellOrBuy =
              targetEl.classList.contains("text-Sell") ||
              targetEl.classList.contains("text-Buy") ||
              targetEl.className.includes("text-Sell") ||
              targetEl.className.includes("text-Buy");

            if (hasFlex100 && hasUSDT && isSellOrBuy) {
              const match = targetEl.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
              if (match && match[1]) {
                const newValue = parseFloat(match[1].replace(/,/g, ""));
                if (isValidSizeChange(newValue, originalSizeValues.get(targetEl))) {
                  originalSizeValues.set(targetEl, newValue);
                  desktopSizeToProcess.add(targetEl);
                }
              }
            }

            // Also check child elements that might be size displays
            if (targetEl.querySelector) {
              const sizeChild =
                targetEl.querySelector('[class*="text-"][style*="flex"]') ||
                targetEl.querySelector('[style*="100px"]');
              if (
                sizeChild &&
                sizeChild.textContent.includes("USDT") &&
                (sizeChild.classList.contains("text-Sell") || sizeChild.classList.contains("text-Buy"))
              ) {
                const match = sizeChild.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
                if (match && match[1]) {
                  const newValue = parseFloat(match[1].replace(/,/g, ""));
                  if (isValidSizeChange(newValue, originalSizeValues.get(sizeChild))) {
                    originalSizeValues.set(sizeChild, newValue);
                    desktopSizeToProcess.add(sizeChild);
                  }
                }
              }
            }
          }
        }

        // =================================================================
        // CASE 6: TEXT CHANGES — ROI elements (triggers PNL recalculation)
        // =================================================================
        if (mutation.type === "characterData" || mutation.type === "childList") {
          let targetEl = mutation.target;
          if (targetEl.nodeType !== 1) targetEl = targetEl.parentElement;

          // Check if this is an ROI element (has %, is colored, is t-caption1)
          if (
            targetEl &&
            targetEl.classList &&
            targetEl.textContent.includes('%') &&
            (targetEl.classList.contains("text-TextSell") || targetEl.classList.contains("text-TextBuy")) &&
            (targetEl.classList.contains("t-caption1") || targetEl.classList.contains("typography-caption2"))
          ) {
            // Check if this ROI element is part of a tracked position card
            const card = roiToCardMapping.get(targetEl);
            if (card) {
              const newRoi = extractRoiValue(targetEl);
              if (newRoi !== null) {
                const oldRoi = currentRoiValues.get(targetEl);
                if (oldRoi === undefined || Math.abs(newRoi - oldRoi) > 0.0001) {
                  currentRoiValues.set(targetEl, newRoi);
                  updatePnlFromRoi(card);
                  
                  console.log("PNL Modifier: ROI changed, recalculating PNL:", {
                    oldRoi: oldRoi ? `${(oldRoi * 100).toFixed(2)}%` : 'initial',
                    newRoi: `${(newRoi * 100).toFixed(2)}%`
                  });
                }
              }
            }
          }
        }

      } // end for (mutation of mutations)

      // Queue all discovered elements for batched processing
      desktopPnlToProcess.forEach((el) => queueDesktopPnlUpdate(el));
      mobilePnlToProcess.forEach((el) => queueMobilePnlUpdate(el));
      desktopSizeToProcess.forEach((el) => queueDesktopSizeUpdate(el));
      mobileSizeToProcess.forEach((el) => queueMobileSizeUpdate(el));
      mobileMarginToProcess.forEach((el) => queueMobileMarginUpdate(el));

    } catch (err) {
      console.warn("PNL Modifier: Error handling mutations:", err);
    }
  }

  // ===========================================================================
  // FULL DOM SCAN
  // ===========================================================================

  /**
   * Perform a full scan of the visible DOM for PNL and size elements.
   * Called on initialization, scroll, resize, and periodic intervals.
   * Only queues elements that are visible in the viewport and haven't
   * already been modified.
   */
  function performFullScan() {
    try {
      // ==================================================================
      // STEP 0: Link position cards for ROI-based PNL calculation
      // ==================================================================
      SELECTORS.positionCards.forEach((selector) => {
        try {
          document.querySelectorAll(selector).forEach((card) => {
            if (isInViewport(card) && !positionCardMapping.has(card)) {
              linkPositionCard(card);
            }
          });
        } catch (e) {
          // Selector might fail, continue with next
        }
      });

      // --- Desktop PNL elements (140px flex containers with USDT text) ---
      document
        .querySelectorAll('div[style*="flex: 1 0 140px"], div[style*="flex:1 0 140px"]')
        .forEach((container) => {
          if (isInViewport(container)) {
            const truncateEl = findFirstMatch(container, SELECTORS.truncateElements);
            if (truncateEl && truncateEl.textContent.includes("USDT") && !modifiedPnlElements.has(truncateEl)) {
              queueDesktopPnlUpdate(container);
            }
          }
        });

      // --- Mobile PNL elements ---
      SELECTORS.mobilePnlElements.forEach((selector) => {
        try {
          document.querySelectorAll(selector).forEach((element) => {
            if (isInViewport(element)) {
              const text = element.textContent.trim();
              if (
                text.match(/^[+-]?[\d,]+\.?\d*$/) &&
                (element.classList.contains("text-TextSell") || element.classList.contains("text-TextBuy")) &&
                !modifiedPnlElements.has(element)
              ) {
                // Verify it's in an "Unrealized PNL" context
                const parentRow =
                  element.closest(".flex.justify-between.mb-\\[8px\\]") ||
                  element.closest(".flex.justify-between");
                if (parentRow) {
                  const label = parentRow.querySelector('[class*="t-caption1"]');
                  if (label && label.textContent.includes("Unrealized PNL")) {
                    if (isMacOS) {
                      console.log("PNL Modifier (macOS): Scheduling mobile PNL update for:", {
                        text: text,
                        selector: selector,
                        classes: element.className,
                        hasTextSell: element.classList.contains("text-TextSell"),
                        hasTextBuy: element.classList.contains("text-TextBuy")
                      });
                    }
                    queueMobilePnlUpdate(element);
                  }
                }
              }
            }
          });
        } catch (err) {
          if (isMacOS) {
            console.warn("PNL Modifier (macOS): Mobile PNL selector failed:", selector, err);
          }
        }
      });

      // --- Mobile SIZE elements ---
      SELECTORS.mobileSizeElements.forEach((selector) => {
        try {
          document.querySelectorAll(selector).forEach((element) => {
            if (isInViewport(element)) {
              const text = element.textContent.trim();
              if (
                text.match(/^([+-]?[\d,]+\.?\d*)$/) &&
                !element.classList.contains("text-TextSell") &&
                !element.classList.contains("text-TextBuy") &&
                element.classList.contains("t-body2") &&
                !modifiedMobileSizeElements.has(element)
              ) {
                if (element.closest(".grid.grid-cols-3")) {
                  const col = element.closest(".flex.flex-col.items-left") ||
                              element.closest(".flex.flex-col");
                  if (col) {
                    const label = col.querySelector('[class*="t-caption1"]');
                    if (label && label.textContent.includes("Size")) {
                      queueMobileSizeUpdate(element);
                      console.log("PNL Modifier: Scheduled mobile size element update:", {
                        text: text,
                        selector: selector,
                        hasLabel: !!label
                      });
                    }
                  }
                }
              }
            }
          });
        } catch (e) { /* selector may fail */ }
      });

      // --- Mobile MARGIN elements (middle column in grid-cols-3) ---
      SELECTORS.mobileMarginElements.forEach((selector) => {
        try {
          document.querySelectorAll(selector).forEach((element) => {
            if (
              !element.classList.contains("text-TextSell") &&
              !element.classList.contains("text-TextBuy") &&
              element.classList.contains("t-body2") &&
              !modifiedMobileMarginElements.has(element) &&
              isInViewport(element)
            ) {
              // Validate by checking label contains "Margin"
              const col = element.closest(".flex.flex-col");
              if (col) {
                const label = col.querySelector('[class*="t-caption1"]');
                if (label && label.textContent.includes("Margin")) {
                  const text = element.firstChild?.nodeValue?.trim() || element.textContent.trim();
                  if (text.match(/^[\d,]+\.?\d*$/)) {
                    queueMobileMarginUpdate(element);
                  }
                }
              }
            }
          });
        } catch (e) { /* selector may fail */ }
      });

      // --- Desktop SIZE elements (100px flex containers with USDT + Sell/Buy) ---
      [
        'div[style*="flex: 1 0 100px"]',
        'div[style*="flex:1 0 100px"]',
        'div[style*="flex: 1 0 100"]',
        'div[style*="flex:1 0 100"]',
        '[style*="100px"][class*="text-"]',
        '[class*="text-Sell"][style*="flex"]',
        '[class*="text-Buy"][style*="flex"]'
      ].forEach((selector) => {
        try {
          document.querySelectorAll(selector).forEach((element) => {
            if (isInViewport(element)) {
              const hasUSDT = element.textContent.includes("USDT");
              const isSellOrBuy =
                element.classList.contains("text-Sell") ||
                element.classList.contains("text-Buy") ||
                element.className.includes("text-Sell") ||
                element.className.includes("text-Buy");
              const hasFlex100 =
                element.style.flex &&
                (element.style.flex.includes("100px") || element.style.flex.includes("100"));

              if (hasUSDT && (isSellOrBuy || hasFlex100) && !modifiedSizeElements.has(element)) {
                queueDesktopSizeUpdate(element);
              }
            }
          });
        } catch (e) { /* selector issue */ }
      });

    } catch (err) {
      console.warn("PNL Modifier: Error in performUpdates:", err);
    }
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Main initialization function. Sets up:
   *   1. MutationObserver on the best container element found
   *   2. Scroll and wheel event listeners (throttled)
   *   3. Resize event listener
   *   4. Periodic interval for cache cleanup and re-verification
   *   5. Diagnostic logging for macOS
   */
  function initialize() {
    try {
      // --- Find the best container element to observe ---
      let observeTarget = null;
      for (const selector of SELECTORS.containers) {
        observeTarget = document.querySelector(selector);
        if (observeTarget) {
          console.log(`PNL Modifier: Found container with selector: ${selector}`);
          break;
        }
      }
      if (!observeTarget) {
        observeTarget = document.body;
        console.log("PNL Modifier: Using body as fallback container");
      }

      // --- Set up the main MutationObserver ---
      new MutationObserver(handleMutations).observe(observeTarget, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false // We don't need attribute changes
      });

      // --- Perform initial scan ---
      performFullScan();

      // --- Register scroll/wheel event listeners ---
      const passiveOpts = { passive: true, capture: false };
      window.addEventListener("scroll", handleScrollEvent, passiveOpts);
      document.addEventListener("wheel", handleScrollEvent, passiveOpts);

      // Also listen for scroll on overflow containers
      [
        observeTarget,
        ...document.querySelectorAll('div[style*="overflow"]'),
        ...document.querySelectorAll('div[style*="overflow-x"]')
      ]
        .filter(Boolean)
        .forEach((el) => {
          if (el !== document.body) {
            el.addEventListener("scroll", handleScrollEvent, passiveOpts);
          }
        });

      // --- Register resize handler (debounced full scan) ---
      window.addEventListener(
        "resize",
        () => {
          setTimeout(performFullScan, 100);
        },
        passiveOpts
      );

      // =================================================================
      // PERIODIC MAINTENANCE INTERVAL (every 5 seconds)
      // =================================================================
      setInterval(() => {
        const now = Date.now();

        // --- Refresh ROI-based PNL calculations for all tracked cards ---
        positionCardMapping.forEach((cardData, card) => {
          if (document.body.contains(card)) {
            updatePnlFromRoi(card);
          } else {
            // Clean up stale card mappings
            positionCardMapping.delete(card);
          }
        });

        // --- Clean up expired cache entries ---
        for (const [element, timestamp] of pnlModificationTimes.entries()) {
          if (now - timestamp > CACHE_EXPIRY_MS) {
            pnlModificationTimes.delete(element);
            originalPnlValues.delete(element);
          }
        }
        for (const [element, timestamp] of sizeModificationTimes.entries()) {
          if (now - timestamp > CACHE_EXPIRY_MS) {
            sizeModificationTimes.delete(element);
            originalSizeValues.delete(element);
          }
        }
        for (const [element, timestamp] of mobileSizeModificationTimes.entries()) {
          if (now - timestamp > CACHE_EXPIRY_MS) {
            mobileSizeModificationTimes.delete(element);
            originalMobileSizeValues.delete(element);
          }
        }

        // --- Re-scan the DOM for any missed or reset elements ---
        performFullScan();

        // --- Verify and re-apply desktop PNL modifications ---
        document
          .querySelectorAll('div[style*="flex: 1 0 140px"], div[style*="flex:1 0 140px"]')
          .forEach((container) => {
            const truncateEl = findFirstMatch(container, SELECTORS.truncateElements);
            if (truncateEl && originalPnlValues.has(container)) {
              const match = truncateEl.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
              if (match && match[1]) {
                const currentNumber = parseFloat(match[1].replace(/,/g, ""));
                const storedOriginal = originalPnlValues.get(container);
                const expectedMultiplied = storedOriginal * MULTIPLIER;

                if (Math.abs(currentNumber - expectedMultiplied) > 0.01) {
                  if (isValidPnlChange(currentNumber, storedOriginal)) {
                    // Genuine data update
                    originalPnlValues.set(container, currentNumber);
                    const newMultiplied = currentNumber * MULTIPLIER;
                    const newText = `${newMultiplied > 0 ? "+" : ""}${formatNumber(Math.abs(newMultiplied), 'pnl')} USDT`;
                    truncateEl.textContent = newText;
                    truncateEl._protectionObserver && truncateEl._protectionObserver.disconnect();
                    setupDesktopPnlProtection(truncateEl, newText);
                  } else {
                    // Binance reset our text — restore
                    const restoredText = `${expectedMultiplied > 0 ? "+" : ""}${formatNumber(Math.abs(expectedMultiplied), 'pnl')} USDT`;
                    truncateEl.textContent = restoredText;
                    if (!pnlProtectedElements.has(truncateEl)) {
                      setupDesktopPnlProtection(truncateEl, restoredText);
                    }
                  }
                }
              }
            }
          });

        // --- Verify and re-apply mobile PNL modifications ---
        SELECTORS.mobilePnlElements.forEach((selector) => {
          try {
            document.querySelectorAll(selector).forEach((element) => {
              if (element.classList.contains("text-TextSell") && originalPnlValues.has(element)) {
                const match = element.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
                if (match && match[1]) {
                  const currentNumber = parseFloat(match[1].replace(/,/g, ""));
                  const storedOriginal = originalPnlValues.get(element);
                  const expectedMultiplied = storedOriginal * MULTIPLIER;

                  if (Math.abs(currentNumber - expectedMultiplied) > 0.01) {
                    if (isValidPnlChange(currentNumber, storedOriginal)) {
                      originalPnlValues.set(element, currentNumber);
                      const newMultiplied = currentNumber * MULTIPLIER;
                      const newText = `${newMultiplied > 0 ? "+" : ""}${formatNumber(Math.abs(newMultiplied), 'pnl')}`;
                      element.textContent = newText;
                      element._mobilePnlProtectionObserver && element._mobilePnlProtectionObserver.disconnect();
                      setupMobilePnlProtection(element, newText);
                    } else {
                      const restoredText = `${expectedMultiplied > 0 ? "+" : ""}${formatNumber(Math.abs(expectedMultiplied), 'pnl')}`;
                      element.textContent = restoredText;
                      if (!pnlProtectedElements.has(element)) {
                        setupMobilePnlProtection(element, restoredText);
                      }
                    }
                  }
                }
              }
            });
          } catch (e) { /* selector may fail */ }
        });

        // --- Verify and re-apply mobile SIZE modifications ---
        SELECTORS.mobileSizeElements.forEach((selector) => {
          try {
            document.querySelectorAll(selector).forEach((element) => {
              if (
                !element.classList.contains("text-TextSell") &&
                !element.classList.contains("text-TextBuy") &&
                element.classList.contains("t-body2") &&
                originalMobileSizeValues.has(element)
              ) {
                const match = element.textContent.trim().match(/^([+-]?[\d,]+\.?\d*)$/);
                if (match && match[1]) {
                  const currentNumber = parseFloat(match[1].replace(/,/g, ""));
                  const storedOriginal = originalMobileSizeValues.get(element);
                  const expectedMultiplied = storedOriginal * MULTIPLIER;

                  if (Math.abs(currentNumber - expectedMultiplied) > 0.01) {
                    if (isValidSizeChange(currentNumber, storedOriginal)) {
                      originalMobileSizeValues.set(element, currentNumber);
                      const newMultiplied = currentNumber * MULTIPLIER;
                      const sign = newMultiplied < 0 ? "-" : "";
                      const newText = sign + formatNumber(Math.abs(newMultiplied), 'size');
                      element.textContent = newText;
                      element._mobileSizeProtectionObserver && element._mobileSizeProtectionObserver.disconnect();
                      setupMobileSizeProtection(element, newText);
                    } else {
                      const sign = expectedMultiplied < 0 ? "-" : "";
                      const restoredText = sign + formatNumber(Math.abs(expectedMultiplied), 'size');
                      element.textContent = restoredText;
                      if (!mobileSizeProtectedElements.has(element)) {
                        setupMobileSizeProtection(element, restoredText);
                      }
                    }
                  }
                }
              }
            });
          } catch (e) { /* selector may fail */ }
        });

        // --- Verify and re-apply mobile MARGIN modifications ---
        SELECTORS.mobileMarginElements.forEach((selector) => {
          try {
            document.querySelectorAll(selector).forEach((element) => {
              if (
                !element.classList.contains("text-TextSell") &&
                !element.classList.contains("text-TextBuy") &&
                element.classList.contains("t-body2") &&
                originalMobileMarginValues.has(element)
              ) {
                // Extract text from text node to exclude SVG
                let textContent = "";
                if (element.firstChild && element.firstChild.nodeType === 3) {
                  textContent = element.firstChild.nodeValue.trim();
                } else {
                  textContent = element.textContent.trim();
                }
                
                const match = textContent.match(/^([+-]?[\d,]+\.?\d*)$/);
                if (match && match[1]) {
                  const currentNumber = parseFloat(match[1].replace(/,/g, ""));
                  const storedOriginal = originalMobileMarginValues.get(element);
                  const expectedMultiplied = storedOriginal * MULTIPLIER;

                  if (Math.abs(currentNumber - expectedMultiplied) > 0.01) {
                    if (isValidSizeChange(currentNumber, storedOriginal)) {
                      // Valid data change - update stored original and re-multiply
                      originalMobileMarginValues.set(element, currentNumber);
                      const newMultiplied = currentNumber * MULTIPLIER;
                      const sign = newMultiplied < 0 ? "-" : "";
                      const newText = sign + formatNumber(Math.abs(newMultiplied), 'margin');
                      
                      if (element.firstChild && element.firstChild.nodeType === 3) {
                        element.firstChild.nodeValue = newText;
                      } else {
                        const svg = element.querySelector("svg");
                        element.textContent = newText;
                        if (svg) element.appendChild(svg);
                      }
                      
                      element._mobileMarginProtectionObserver && element._mobileMarginProtectionObserver.disconnect();
                      setupMobileMarginProtection(element, newText);
                    } else {
                      // Invalid change - restore multiplied value
                      const sign = expectedMultiplied < 0 ? "-" : "";
                      const restoredText = sign + formatNumber(Math.abs(expectedMultiplied), 'margin');
                      
                      if (element.firstChild && element.firstChild.nodeType === 3) {
                        element.firstChild.nodeValue = restoredText;
                      } else {
                        const svg = element.querySelector("svg");
                        element.textContent = restoredText;
                        if (svg) element.appendChild(svg);
                      }
                      
                      if (!mobileMarginProtectedElements.has(element)) {
                        setupMobileMarginProtection(element, restoredText);
                      }
                    }
                  }
                }
              }
            });
          } catch (e) { /* selector may fail */ }
        });

        // --- Verify and re-apply desktop SIZE modifications ---
        [
          'div[style*="flex: 1 0 100px"]',
          'div[style*="flex:1 0 100px"]',
          'div[style*="flex: 1 0 100"]',
          'div[style*="flex:1 0 100"]',
          '[style*="100px"][class*="text-"]',
          '[class*="text-Sell"][style*="flex"]',
          '[class*="text-Buy"][style*="flex"]'
        ].forEach((selector) => {
          try {
            document.querySelectorAll(selector).forEach((element) => {
              const hasUSDT = element.textContent.includes("USDT");
              const isSellOrBuy =
                element.classList.contains("text-Sell") ||
                element.classList.contains("text-Buy") ||
                element.className.includes("text-Sell") ||
                element.className.includes("text-Buy");
              const hasFlex100 =
                element.style.flex &&
                (element.style.flex.includes("100px") || element.style.flex.includes("100"));

              if (hasUSDT && (isSellOrBuy || hasFlex100) && originalSizeValues.has(element)) {
                const match = element.textContent.trim().match(/([+-]?[\d,]+\.?\d*)\s*USDT/i);
                if (match && match[1]) {
                  const currentNumber = parseFloat(match[1].replace(/,/g, ""));
                  const storedOriginal = originalSizeValues.get(element);
                  const expectedMultiplied = storedOriginal * MULTIPLIER;

                  if (Math.abs(currentNumber - expectedMultiplied) > 0.01) {
                    if (isValidSizeChange(currentNumber, storedOriginal)) {
                      // Genuine update
                      originalSizeValues.set(element, currentNumber);
                      const newMultiplied = currentNumber * MULTIPLIER;
                      const sign =
                        element.classList.contains("text-Sell") ||
                        element.className.includes("text-Sell") ||
                        currentNumber < 0
                          ? "-"
                          : "";
                      const formatted = formatNumber(Math.abs(newMultiplied), 'size');
                      const protectionText = `${sign}${formatted}\nUSDT`;
                      try {
                        element.innerHTML = `${sign}${formatted}<br>USDT`;
                      } catch (e) {
                        element.textContent = `${sign}${formatted} USDT`;
                      }
                      element._sizeProtectionObserver && element._sizeProtectionObserver.disconnect();
                      setupDesktopSizeProtection(element, protectionText);
                    } else {
                      // Restore our value
                      const sign =
                        element.classList.contains("text-Sell") ||
                        element.className.includes("text-Sell") ||
                        expectedMultiplied < 0
                          ? "-"
                          : "";
                      const formatted = formatNumber(Math.abs(expectedMultiplied), 'size');
                      const protectionText = `${sign}${formatted}\nUSDT`;
                      try {
                        element.innerHTML = `${sign}${formatted}<br>USDT`;
                      } catch (e) {
                        element.textContent = `${sign}${formatted} USDT`;
                      }
                      if (!sizeProtectedElements.has(element)) {
                        setupDesktopSizeProtection(element, protectionText);
                      }
                    }
                  }
                }
              }
            });
          } catch (e) { /* selector issue */ }
        });

      }, 5000); // Run every 5 seconds

      // --- Success log ---
      console.log(
        `Ultra-Optimized PNL Modifier started successfully! (${isMacOS ? "macOS" : "Windows"} optimized)`
      );
      console.log(
        "✨ NEW: Real-time PNL calculation enabled! PNL will update automatically when ROI changes."
      );
      console.log(
        "📊 Formula: PNL = ROI × Margin × " + MULTIPLIER.toLocaleString()
      );
      console.log(
        "🔒 ROBUST: Original values stored in dataset - immune to formatting changes"
      );

      // =================================================================
      // macOS DIAGNOSTIC: Log potential size elements after 2 seconds
      // =================================================================
      if (isMacOS) {
        setTimeout(() => {
          const potentialSizeEls = document.querySelectorAll(
            '[style*="100px"], [class*="text-Sell"], [class*="text-Buy"]'
          );
          console.log(`PNL Modifier: Found ${potentialSizeEls.length} potential size elements on macOS`);
          let validCount = 0;
          potentialSizeEls.forEach((el) => {
            if (el.textContent.includes("USDT")) {
              validCount++;
              console.log("PNL Modifier: Valid size element found:", {
                text: el.textContent.trim(),
                flex: el.style.flex,
                classes: el.className,
                hasUSDT: el.textContent.includes("USDT")
              });
            }
          });
          console.log(`PNL Modifier: ${validCount} valid size elements with USDT found on macOS`);
        }, 2000);
      }

      // =================================================================
      // DIAGNOSTIC: Log potential mobile PNL elements after 3 seconds
      // =================================================================
      setTimeout(() => {
        const potentialMobilePnl = document.querySelectorAll(".text-TextSell.t-body2");
        console.log(`PNL Modifier: Found ${potentialMobilePnl.length} potential mobile PNL elements`);
        let validCount = 0;
        potentialMobilePnl.forEach((el) => {
          const text = el.textContent.trim();
          if (text.match(/^[+-]?[\d,]+\.?\d*$/)) {
            validCount++;
            console.log("PNL Modifier: Valid mobile PNL element found:", {
              text: text,
              classes: el.className,
              parent: el.parentElement ? el.parentElement.className : "no parent"
            });
          }
        });
        console.log(`PNL Modifier: ${validCount} valid mobile PNL elements found`);

        // macOS extra diagnostics: test each mobile PNL selector
        if (isMacOS) {
          console.log("PNL Modifier (macOS): Testing all mobile PNL selectors...");
          SELECTORS.mobilePnlElements.forEach((selector, index) => {
            try {
              const matches = document.querySelectorAll(selector);
              console.log(
                `PNL Modifier (macOS): Selector ${index + 1} (${selector}): found ${matches.length} elements`
              );
              matches.forEach((el, elIndex) => {
                const text = el.textContent.trim();
                const hasTextSell = el.classList.contains("text-TextSell");
                const matchesPattern = text.match(/^[+-]?[\d,]+\.?\d*$/);
                console.log(
                  `  Element ${elIndex + 1}: "${text}", hasTextSell: ${hasTextSell}, matchesPattern: ${!!matchesPattern}`
                );
              });
            } catch (err) {
              console.warn(`PNL Modifier (macOS): Selector failed: ${selector}`, err);
            }
          });
        }

        // Check if POSITIONS container exists
        const positionsContainer = document.querySelector("#POSITIONS");
        if (positionsContainer) {
          console.log("PNL Modifier: POSITIONS container found");
          const positionDivs = positionsContainer.querySelectorAll(".py-\\[16px\\]");
          console.log(`PNL Modifier: Found ${positionDivs.length} position divs`);
        } else {
          console.log("PNL Modifier: POSITIONS container NOT found");
        }
      }, 3000);

      // =================================================================
      // DIAGNOSTIC: Log potential mobile SIZE elements after 4 seconds
      // =================================================================
      setTimeout(() => {
        const potentialMobileSize = document.querySelectorAll(
          "#POSITIONS .t-body2:not(.text-TextSell)"
        );
        console.log(`PNL Modifier: Found ${potentialMobileSize.length} potential mobile size elements`);
        let validCount = 0;
        potentialMobileSize.forEach((el) => {
          const text = el.textContent.trim();
          const gridContainer = el.closest(".grid.grid-cols-3");
          const label = gridContainer?.querySelector('[class*="t-caption1"]');
          if (text.match(/^[\d,]+\.?\d*$/) && label && label.textContent.includes("Size")) {
            validCount++;
            console.log(`Mobile Size Element: "${text}" in context: "${label.textContent}"`);
          }
        });
        console.log(`PNL Modifier: ${validCount} valid mobile size elements found`);
      }, 4000);

      // =================================================================
      // DIAGNOSTIC: Log potential mobile MARGIN elements after 5 seconds
      // =================================================================
      setTimeout(() => {
        console.log("\n=== MOBILE MARGIN DIAGNOSTIC ===");
        const potentialMobileMargin = document.querySelectorAll(
          "#POSITIONS .grid.grid-cols-3 .flex.flex-col:not(.items-left):not(.items-end) .t-body2"
        );
        console.log(`PNL Modifier: Found ${potentialMobileMargin.length} potential mobile margin elements`);
        let validMarginCount = 0;
        potentialMobileMargin.forEach((el) => {
          const textNode = el.firstChild?.nodeType === 3 ? el.firstChild.nodeValue.trim() : el.textContent.trim();
          const col = el.closest(".flex.flex-col");
          const label = col?.querySelector('[class*="t-caption1"]');
          const hasSVG = el.querySelector("svg") !== null;
          if (textNode.match(/^[\d,]+\.?\d*$/) && label && label.textContent.includes("Margin")) {
            validMarginCount++;
            console.log(`Mobile Margin Element: "${textNode}" (SVG: ${hasSVG}) in context: "${label.textContent}"`);
          }
        });
        console.log(`PNL Modifier: ${validMarginCount} valid mobile margin elements found`);
        console.log(`Modified margin count: ${modifiedMobileMarginElements.size || 0}`);
        console.log(`Tracked margin values: ${originalMobileMarginValues.size}`);
      }, 5000);

      // =================================================================
      // DIAGNOSTIC: Log ROI tracking status after 6 seconds
      // =================================================================
      setTimeout(() => {
        console.log("\n=== ROI-BASED PNL TRACKING DIAGNOSTIC ===");
        console.log(`Position cards linked: ${positionCardMapping.size}`);
        console.log(`ROI elements tracked: ${currentRoiValues.size}`);
        
        positionCardMapping.forEach((cardData, card) => {
          const roiValue = currentRoiValues.get(cardData.roi);
          const roiText = cardData.roi?.textContent.trim() || 'N/A';
          const marginText = cardData.margin?.textContent.trim() || 'N/A';
          const pnlText = cardData.pnl?.textContent.trim() || 'N/A';
          
          console.log(`Position Card:`, {
            ROI: roiText,
            'ROI Value': roiValue !== undefined ? `${(roiValue * 100).toFixed(2)}%` : 'N/A',
            Margin: marginText.substring(0, 20),
            PNL: pnlText.substring(0, 30),
            'Card Visible': isInViewport(card)
          });
        });
        
        if (positionCardMapping.size === 0) {
          console.warn("⚠️ No position cards linked! ROI tracking may not be working.");
          console.log("Checking for position cards in DOM...");
          SELECTORS.positionCards.forEach((selector) => {
            const cards = document.querySelectorAll(selector);
            console.log(`  ${selector}: ${cards.length} found`);
          });
        } else {
          console.log("✅ ROI tracking is active and will update PNL in real-time!");
        }
      }, 6000);

    } catch (err) {
      console.error("PNL Modifier: Error during initialization:", err);
    }
  }

  // ===========================================================================
  // STARTUP — Wait for DOM and Binance UI to be ready
  // ===========================================================================

  /**
   * Poll the DOM until Binance UI elements are detected, then initialize.
   * Checks for:
   *   - PNL containers (140px flex divs)
   *   - Any known container selector
   *   - Generic Binance class names (bn-, binance)
   *   - Falls back after 50 attempts (~7.5-12.5 seconds)
   */
  function waitForDomAndStart() {
    let attempts = 0;

    const pollingInterval = setInterval(() => {
      attempts++;

      try {
        // Check if PNL elements exist
        const hasPnlElements =
          document.querySelectorAll(
            'div[style*="flex: 1 0 140px"], div[style*="flex:1 0 140px"]'
          ).length > 0;

        // Check if any known container exists
        const hasContainer = SELECTORS.containers.some((sel) => document.querySelector(sel));

        // Check for generic Binance-like elements
        const hasBinanceUI =
          document.querySelector('div[class*="bn-"]') ||
          document.querySelector('div[class*="binance"]') ||
          document.body.children.length > 5;

        // Start if we found something, or give up after 50 attempts
        if (hasPnlElements || hasContainer || hasBinanceUI || attempts >= 50) {
          clearInterval(pollingInterval);
          initialize();

          if (hasPnlElements || hasContainer) {
            console.log("PNL Modifier: Started successfully after " + attempts + " attempts");
          } else {
            console.log("PNL Modifier: Started in fallback mode after " + attempts + " attempts");
          }
        }
      } catch (err) {
        console.warn("PNL Modifier: Error during startup check:", err);
        if (attempts >= 50) {
          clearInterval(pollingInterval);
          initialize();
        }
      }
    }, isMacOS ? platformStartupInterval : 150);
  }

  // ===========================================================================
  // ENTRY POINT
  // ===========================================================================

  /**
   * Start the script:
   *   - If DOM is still loading, wait for DOMContentLoaded
   *   - If DOM is already loaded, start after a short delay
   */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForDomAndStart);
  } else {
    setTimeout(waitForDomAndStart, isMacOS ? 300 : 100);
  }

}();
