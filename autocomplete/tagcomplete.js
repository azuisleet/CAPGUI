let tagCompletionData = {
    ready: false, tags: [], tagData: {}, tagTries: {},
    currentCandidates: [], currentIndex: -1, currentRange: null,
};
let popover;
let pendingCompletion;
let suppressNextInput;

const TagFile = "autocomplete/csv/resonance_furry.csv";
const WorkingTagDelimiters = ".,/!?%^*;:{}=`~\n";

const NumberFormat = new Intl.NumberFormat();

function normalize(input) {
    return input.toLowerCase().trim();
}

function pushTag(tag, data) {
    tag = normalize(tag);
    const index = tagCompletionData.tags.push(tag);
    tagCompletionData.tagData[tag] = data;

    let node = tagCompletionData.tagTries;
    for (let i = 0; i < tag.length; i++) {
        const l = tag[i];
        if (!node[l]) node[l] = {};
        if (i === tag.length - 1) node[l].$ = index - 1;
        node = node[l];
    }
}

function collect(n, results) {
    if (n.$ !== undefined) results.push(n.$);
    for (const k in n) {
        if (k !== "$") collect(n[k], results);
    }
    return results;
}

function findPrefixCandidates(input) {
    let i = 0;
    let node = tagCompletionData.tagTries;
    // Search for a prefix matching the input, within the bounds of the trie
    while (node[input[i]]) node = node[input[i++]];
    // If the input is longer than the search, abort
    if (i < input.length) return [];
    const indices = collect(node, []);
    // We have a list of indices, but they aren't ordered by insertion after walking
    indices.sort((x, y) => x - y);
    return indices.map(idx => tagCompletionData.tags[idx]);
}

function hide() {
    popover.hidePopover();
}

function insertSelectedTag(target, tag, selectionStart, selectionEnd) {
    tag = tag.replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("_", " ");
    let placed = tag;

    const input = target.value;
    const leading = input.substring(0, selectionStart);
    const trailing = input.substring(selectionEnd);

    // Expand placed to include a comma and space if not available
    if (!trailing.trimStart().startsWith(',')) placed = `${placed}, `;

    suppressNextInput = true;

    target.focus();
    target.setSelectionRange(selectionStart, selectionEnd);
    document.execCommand("insertText", false, placed);

    // Gradio callback
    updateInput(target);
}

function performCompletionAndShow(target, caretRect, tag, selectionStart, selectionEnd) {
    tag = tag.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll(" ", "_");

    //console.time(`Find candidates: ${tag}`);
    const normalized = normalize(tag);
    const candidates = tagCompletionData.currentCandidates = findPrefixCandidates(tag).slice(0, 5);
    tagCompletionData.currentIndex = -1;
    tagCompletionData.currentRange = {selectionStart, selectionEnd};
    //console.timeEnd(`Find candidates: ${tag}`);

    if (candidates.length > 1 || (candidates.length > 0 && candidates[0] !== normalized)) {
        const {left, bottom} = target.getBoundingClientRect();
        const {left: caretLeft} = caretRect;

        popover.style.left = window.scrollX + left + caretLeft + 'px';
        popover.style.top = window.scrollY + bottom + 4 + 'px';

        const ul = popover.querySelector("ul");
        ul.innerHTML = '';
        for (const candidate of candidates) {
            const li = document.createElement("li");
            const label = document.createElement("span");
            label.textContent = candidate;
            const count = document.createElement("span");
            count.textContent = NumberFormat.format(tagCompletionData.tagData[candidate].frequency);
            li.appendChild(label);
            li.appendChild(count);
            li.dataset.class = tagCompletionData.tagData[candidate].classification;
            li.addEventListener("click", () => {
                insertSelectedTag(target, candidate, selectionStart, selectionEnd);
                hide();
            });
            ul.appendChild(li);
        }
        popover.scrollTop = 0;
        popover.showPopover();
    } else {
        popover.hidePopover();
    }
}

function highlightSelectedItem(selectedIndex) {
    tagCompletionData.currentIndex = selectedIndex;

    const ul = popover.querySelector("ul");
    const children = ul.querySelectorAll("li");
    const currentlySelectedItem = ul.querySelector("li[data-selected]");
    if (currentlySelectedItem) delete currentlySelectedItem.dataset.selected;
    if (children[selectedIndex]) children[selectedIndex].dataset.selected = "true";
}

async function loadTagsFromFile(file) {
    const result = await fetch(`file=${file}`);
    if (result.status !== 200) {
        console.error(`Failed to load tag completions: ${result.statusText}`);
        return;
    }
    const text = await result.text();
    const csvLines = text.split('\n');
    await loadTagsCSV(csvLines);
}

function loadTagsCSV(lines) {
    if (lines.length === 0) return false;

    // Chunk the loading work
    const chunkSize = 10000;
    return new Promise((resolve, reject) => {
        let i = 0;

        function processChunk() {
            //console.time(`Chunk ${i}`);
            const chunk = lines.slice(i, i + chunkSize);
            try {
                for (const line of chunk) {
                    const cols = line.split(",");
                    let [tag, classification, frequency] = cols;
                    pushTag(tag, {tag, classification, frequency});
                }
            } catch (err) {
                reject(err);
            }
            //console.timeEnd(`Chunk ${i}`);
            i += chunkSize;
            if (i >= lines.length) resolve(true);
            else requestIdleCallback(processChunk, {timeout: 500});
        }

        requestIdleCallback(processChunk, {timeout: 500});
    });
}

async function initializeData() {
    console.log('Loading tag completion data...');
    console.time('Tag completion data loaded');
    await loadTagsFromFile(TagFile);
    console.timeEnd('Tag completion data loaded');
    tagCompletionData.ready = true;
}

function isTargetVisible(target) {
    const {width, height} = target.getBoundingClientRect();
    return width > 0 && height > 0;
}

function initializeDOM() {
    popover = popover = document.createElement("div");
    popover.id = "tagcomplete";
    popover.popover = "manual";
    popover.tabIndex = -1;
    document.body.appendChild(popover);

    const results = document.createElement("ul");
    popover.appendChild(results);
}

document.addEventListener('DOMContentLoaded', async () => {
    initializeDOM();
    await initializeData();

    if (pendingCompletion) {
        const {target, caretRect, tag, selectionStart, selectionEnd} = pendingCompletion;
        pendingCompletion = null;
        if (isTargetVisible(target)) performCompletionAndShow(target, caretRect, tag, selectionStart, selectionEnd);
    }
});

function getWorkingRange(text, selectionStart, selectionEnd) {
    let delimiters = WorkingTagDelimiters;

    // seek backward to find beginning
    while (!delimiters.includes(text[selectionStart - 1]) && selectionStart > 0) {
        selectionStart--;
    }

    // seek forward to find end
    while (!delimiters.includes(text[selectionEnd]) && selectionEnd < text.length) {
        selectionEnd++;
    }

    // deselect surrounding whitespace
    while (text[selectionStart] === " " && selectionStart < selectionEnd) {
        selectionStart++;
    }
    while (text[selectionEnd - 1] === " " && selectionEnd > selectionStart) {
        selectionEnd--;
    }

    // deselect parenthesis
    while (text[selectionStart] === "(" && selectionStart < selectionEnd) {
        selectionStart++;
    }
    while (text[selectionEnd - 1] === ")" && selectionEnd > selectionStart) {
        selectionEnd--;
    }

    return {selectionStart, selectionEnd};
}

// Caret position calculation from @component/textarea-caret-position
// We'll copy the properties below into the mirror div.
// Note that some browsers, such as Firefox, do not concatenate properties
// into their shorthand (e.g. padding-top, padding-bottom etc. -> padding),
// so we have to list every single property explicitly.
const properties = [
    'direction',  // RTL support
    'boxSizing',
    'width',  // on Chrome and IE, exclude the scrollbar, so the mirror div wraps exactly as the textarea does
    'height',
    'overflowX',
    'overflowY',  // copy the scrollbar for IE

    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderStyle',

    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',

    // https://developer.mozilla.org/en-US/docs/Web/CSS/font
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',

    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',  // might not make a difference, but better be safe

    'letterSpacing',
    'wordSpacing',

    'tabSize',
    'MozTabSize'

];

const isBrowser = (typeof window !== 'undefined');
const isFirefox = (isBrowser && window.mozInnerScreenX != null);

function getCaretCoordinates(element, position, options) {
    if (!isBrowser) {
        throw new Error('textarea-caret-position#getCaretCoordinates should only be called in a browser');
    }

    const debug = options && options.debug || false;
    if (debug) {
        const el = document.querySelector('#input-textarea-caret-position-mirror-div');
        if (el) el.parentNode.removeChild(el);
    }

    // The mirror div will replicate the textarea's style
    const div = document.createElement('div');
    div.id = 'input-textarea-caret-position-mirror-div';
    document.body.appendChild(div);

    const style = div.style;
    const computed = window.getComputedStyle ? window.getComputedStyle(element) : element.currentStyle;  // currentStyle for IE < 9
    const isInput = element.nodeName === 'INPUT';

    // Default textarea styles
    style.whiteSpace = 'pre-wrap';
    if (!isInput)
        style.wordWrap = 'break-word';  // only for textarea-s

    // Position off-screen
    style.position = 'absolute';  // required to return coordinates properly
    if (!debug)
        style.visibility = 'hidden';  // not 'display: none' because we want rendering

    // Transfer the element's properties to the div
    properties.forEach(function (prop) {
        if (isInput && prop === 'lineHeight') {
            // Special case for <input>s because text is rendered centered and line height may be != height
            if (computed.boxSizing === "border-box") {
                const height = parseInt(computed.height);
                const outerHeight =
                    parseInt(computed.paddingTop) +
                    parseInt(computed.paddingBottom) +
                    parseInt(computed.borderTopWidth) +
                    parseInt(computed.borderBottomWidth);
                const targetHeight = outerHeight + parseInt(computed.lineHeight);
                if (height > targetHeight) {
                    style.lineHeight = height - outerHeight + "px";
                } else if (height === targetHeight) {
                    style.lineHeight = computed.lineHeight;
                } else {
                    style.lineHeight = 0;
                }
            } else {
                style.lineHeight = computed.height;
            }
        } else {
            style[prop] = computed[prop];
        }
    });

    if (isFirefox) {
        // Firefox lies about the overflow property for textareas: https://bugzilla.mozilla.org/show_bug.cgi?id=984275
        if (element.scrollHeight > parseInt(computed.height))
            style.overflowY = 'scroll';
    } else {
        style.overflow = 'hidden';  // for Chrome to not render a scrollbar; IE keeps overflowY = 'scroll'
    }

    div.textContent = element.value.substring(0, position);
    // The second special handling for input type="text" vs textarea:
    // spaces need to be replaced with non-breaking spaces - http://stackoverflow.com/a/13402035/1269037
    if (isInput)
        div.textContent = div.textContent.replace(/\s/g, '\u00a0');

    const span = document.createElement('span');
    // Wrapping must be replicated *exactly*, including when a long word gets
    // onto the next line, with whitespace at the end of the line before (#7).
    // The  *only* reliable way to do that is to copy the *entire* rest of the
    // textarea's content into the <span> created at the caret position.
    // For inputs, just '.' would be enough, but no need to bother.
    span.textContent = element.value.substring(position) || '.';  // || because a completely empty faux span doesn't render at all
    div.appendChild(span);

    const coordinates = {
        top: span.offsetTop + parseInt(computed['borderTopWidth']),
        left: span.offsetLeft + parseInt(computed['borderLeftWidth']),
        height: parseInt(computed['lineHeight'])
    };

    if (debug) {
        span.style.backgroundColor = '#aaa';
    } else {
        document.body.removeChild(div);
    }

    return coordinates;
}

function handleInputChange(target) {
    const {selectionStart, selectionEnd} = getWorkingRange(target.value, target.selectionStart, target.selectionEnd);
    const focusTag = target.value.substring(selectionStart, selectionEnd);

    if (!focusTag) {
        hide();
        pendingCompletion = null;
        return;
    }

    const caretRect = getCaretCoordinates(target, selectionEnd);

    if (!tagCompletionData.ready) {
        pendingCompletion = {target, caretRect, tag: focusTag, selectionStart, selectionEnd};
    } else {
        performCompletionAndShow(target, caretRect, focusTag, selectionStart, selectionEnd);
    }
}


// attach event listeners to all matching text elements
const observer = new MutationObserver(() => {
    const textElements = document.querySelectorAll("*:is([id='promptbar'] [id*='_prompt'], .prompt) textarea:not([data-tagcomplete])");
    if (textElements.length === 0) return;

    for (const element of textElements) {
        // handle input changes to text elements
        element.addEventListener("input", (event) => {
            if (!event.inputType && suppressNextInput) return;
            suppressNextInput = false;

            handleInputChange(element);
        });

        // Handle navigation within the autocomplete
        element.addEventListener("keydown", (event) => {
            const currentlyOpen = popover.matches(':popover-open');
            if (event.key === "Escape") {
                if (!currentlyOpen) return;
                event.preventDefault();
                hide();
            } else if (event.key === "ArrowUp") {
                if (!currentlyOpen) return;
                event.preventDefault();
                highlightSelectedItem(tagCompletionData.currentIndex === -1 ?
                    0 :
                    tagCompletionData.currentIndex > 0 ?
                        tagCompletionData.currentIndex - 1 :
                        tagCompletionData.currentCandidates.length - 1);
            } else if (event.key === "ArrowDown") {
                if (!currentlyOpen) return;
                event.preventDefault();
                highlightSelectedItem(tagCompletionData.currentIndex === -1 ?
                    0 :
                    tagCompletionData.currentIndex < tagCompletionData.currentCandidates.length - 1 ?
                        tagCompletionData.currentIndex + 1 :
                        0);
            } else if (event.key === "Tab") {
                if (!currentlyOpen) return;
                event.preventDefault();
                const selectedIndex = tagCompletionData.currentIndex === -1 ? 0 : tagCompletionData.currentIndex;
                const {selectionStart, selectionEnd} = tagCompletionData.currentRange;
                insertSelectedTag(element, tagCompletionData.currentCandidates[selectedIndex], selectionStart, selectionEnd);
                hide();
            } else if (event.key === "Enter") {
                if (!currentlyOpen) return;
                const selectedIndex = tagCompletionData.currentIndex;
                if (selectedIndex === -1) return;
                event.preventDefault();
                const {selectionStart, selectionEnd} = tagCompletionData.currentRange;
                insertSelectedTag(element, tagCompletionData.currentCandidates[selectedIndex], selectionStart, selectionEnd);
                hide();
            }
        });

        // handle focus changes
        element.addEventListener("blur", () => {
            setTimeout(() => {
                const currentlyOpen = popover.matches(':popover-open');
                if (!currentlyOpen || document.activeElement === element || popover.contains(document.activeElement)) return;
                hide();
                pendingCompletion = null;
            });
        });

        element.dataset.tagcomplete = "true";
    }

    observer.disconnect();
});
observer.observe(document, {childList: true, subtree: true});