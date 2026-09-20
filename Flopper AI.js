// ai_chatbot.js
// Offline "AI chatbot" for Flipper Zero, with a menu, a Wikipedia topic list,
// battery reporting, and a teachable memory.
//
// IMPORTANT - SETUP:
// This script expects two data files on the SD card, alongside where it
// stores taught facts:
//   /ext/apps_data/ai_chatbot/dictionary.txt
//   /ext/apps_data/ai_chatbot/wiki.txt
// Copy dictionary.txt and wiki.txt (provided alongside this script) into
// that folder (create the folders if they don't exist yet). The script
// searches these files on demand instead of loading them into memory, so
// they can be as large as you want without running the interpreter out of
// memory - the previous version broke because it baked all that text
// directly into the script, which the interpreter has to parse and hold in
// its much smaller RAM budget. Text files on the SD card don't have that
// problem.
//
// NOTE: Flipper Zero JS has no networking module, so this cannot reach the
// real Wikipedia or any online dictionary. The math evaluator is hand
// written since mJS has no eval().
//
// Main menu:
//   Ask / Chat  -> free text box for definitions, math, teaching, etc.
//   Wikipedia   -> pick a topic from a list to read its summary
//   Battery     -> shows current battery percentage
//   Help        -> shows the command list
//   Exit        -> quits the app
//
// Chat commands (typed into "Ask / Chat"):
//   define <word>                    -> look up word (built-in + taught)
//   wiki <topic>                     -> look up topic (built-in + taught)
//   calc <expr>  /  math <expr>      -> evaluate a math expression
//   <expr>                           -> if it looks like pure math, evaluates it
//   battery                          -> battery percentage
//   teach define <word> = <text>     -> teach a new word definition
//   teach wiki <topic> = <text>      -> teach a new wiki-style summary
//   forget define <word>             -> remove a taught definition
//   forget wiki <topic>              -> remove a taught wiki entry
//   learned                          -> list everything you've taught it
//   hello / hi                       -> greeting
//   help                             -> lists commands
//
// Underscores in anything you type are converted to spaces, e.g.
// "teach_wiki_my_cat_=_an_orange_tabby" becomes "teach wiki my cat = an orange tabby".

let eventLoop = require("event_loop");
let gui = require("gui");
let submenuView = require("gui/submenu");
let textInputView = require("gui/text_input");
let textBoxView = require("gui/text_box");
let storage = require("storage");
let flipper = require("flipper");

let LEARNED_DIR = "/ext/apps_data/ai_chatbot";
let LEARNED_PATH = "/ext/apps_data/ai_chatbot/learned.txt";
let DICTIONARY_PATH = "/ext/apps_data/ai_chatbot/dictionary.txt";
let WIKI_PATH = "/ext/apps_data/ai_chatbot/wiki.txt";

// how many bytes to read at a time while scanning a data file. Small and
// fixed, so memory use never grows with the size of the file being searched.
let READ_CHUNK = 200;

// Taught facts stay small and in memory (they're user-typed, not bulk data),
// kept separate from the built-ins so they can be listed, forgotten, and
// persisted independently. Each entry is a two-element array: [key, value]
let learnedDefs = [];
let learnedWiki = [];

// ---------------------------------------------------------------------
// Small string helpers (mJS has no split() or trim())
// ---------------------------------------------------------------------

// builds a submenu view. Your firmware's gui/submenu view rejects "items"
// as a prop (even though Flipper's official docs list it), so build the
// list using the generic View.addChild() method instead, one item at a
// time - addChild() is documented to exist on every View type.
function makeSubmenu(header, itemLabels) {
    let sm = submenuView.makeWith({ header: header });
    for (let i = 0; i < itemLabels.length; i++) {
        sm.addChild(itemLabels[i]);
    }
    return sm;
}

function trimStr(s) {
    let start = 0;
    while (start < s.length && s.charCodeAt(start) === 32) {
        start = start + 1;
    }
    let end = s.length;
    while (end > start && s.charCodeAt(end - 1) === 32) {
        end = end - 1;
    }
    return s.slice(start, end);
}

// replaces every underscore with a space (so you can type widget_name
// instead of "widget name" if spaces are awkward to enter on-device)
function replaceUnderscoresWithSpaces(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c === 95) { // '_'
            out += " ";
        } else {
            out += s.slice(i, i + 1);
        }
    }
    return out;
}

// find `needle` in `s`, starting the search at index `fromIdx`
function findFrom(s, needle, fromIdx) {
    let rem = s.slice(fromIdx);
    let idx = rem.indexOf(needle);
    if (idx === -1) {
        return -1;
    }
    return fromIdx + idx;
}

// ---------------------------------------------------------------------
// Hand written math expression evaluator (no eval() in mJS)
// Supports + - * / and parentheses, with decimals and unary minus.
// Each parse function takes (str, index) and returns [value, nextIndex].
// ---------------------------------------------------------------------

function skipSpaces(s, i) {
    while (i < s.length && s.charCodeAt(i) === 32) {
        i = i + 1;
    }
    return i;
}

function parseNumberFromString(numStr) {
    let dotIdx = numStr.indexOf(".");
    if (dotIdx === -1) {
        return parseInt(numStr, 10);
    }
    let intPart = numStr.slice(0, dotIdx);
    let fracPart = numStr.slice(dotIdx + 1);
    let intVal = 0;
    if (intPart.length > 0) {
        intVal = parseInt(intPart, 10);
    }
    let fracVal = 0;
    if (fracPart.length > 0) {
        let fracInt = parseInt(fracPart, 10);
        let divisor = 1;
        for (let k = 0; k < fracPart.length; k++) {
            divisor = divisor * 10;
        }
        fracVal = fracInt / divisor;
    }
    return intVal + fracVal;
}

function parseNumber(s, i) {
    let start = i;
    while (i < s.length) {
        let c = s.charCodeAt(i);
        if ((c >= 48 && c <= 57) || c === 46) {
            i = i + 1;
        } else {
            break;
        }
    }
    let numStr = s.slice(start, i);
    return [parseNumberFromString(numStr), i];
}

function parseFactor(s, i) {
    i = skipSpaces(s, i);
    let c = s.charCodeAt(i);
    if (c === 45) { // unary minus
        let r = parseFactor(s, i + 1);
        return [-r[0], r[1]];
    }
    if (c === 40) { // '('
        let r = parseExpr(s, i + 1);
        let j = skipSpaces(s, r[1]);
        if (s.charCodeAt(j) === 41) { // ')'
            j = j + 1;
        }
        return [r[0], j];
    }
    return parseNumber(s, i);
}

function parseTerm(s, i) {
    let r = parseFactor(s, i);
    let value = r[0];
    let j = r[1];
    while (true) {
        j = skipSpaces(s, j);
        let c = j < s.length ? s.charCodeAt(j) : -1;
        if (c === 42) { // '*'
            let r2 = parseFactor(s, j + 1);
            value = value * r2[0];
            j = r2[1];
        } else if (c === 47) { // '/'
            let r2 = parseFactor(s, j + 1);
            value = value / r2[0];
            j = r2[1];
        } else {
            break;
        }
    }
    return [value, j];
}

function parseExpr(s, i) {
    let r = parseTerm(s, i);
    let value = r[0];
    let j = r[1];
    while (true) {
        j = skipSpaces(s, j);
        let c = j < s.length ? s.charCodeAt(j) : -1;
        if (c === 43) { // '+'
            let r2 = parseTerm(s, j + 1);
            value = value + r2[0];
            j = r2[1];
        } else if (c === 45) { // '-'
            let r2 = parseTerm(s, j + 1);
            value = value - r2[0];
            j = r2[1];
        } else {
            break;
        }
    }
    return [value, j];
}

function evalMath(expr) {
    let r = parseExpr(expr, 0);
    return r[0];
}

function isMathExpression(s) {
    if (s.length === 0) {
        return false;
    }
    let sawDigit = false;
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        let isDigit = (c >= 48 && c <= 57);
        let ok = isDigit || c === 32 || c === 46 || c === 43 || c === 45 || c === 42 || c === 47 || c === 40 || c === 41;
        if (!ok) {
            return false;
        }
        if (isDigit) {
            sawDigit = true;
        }
    }
    return sawDigit;
}

// ---------------------------------------------------------------------
// Streaming file search (reads a small chunk at a time, never the whole
// file at once, so memory use doesn't grow with file size)
// ---------------------------------------------------------------------

// Looks for a line "key::value" whose key matches `wantKey`. Returns the
// value, or undefined if not found or the file doesn't exist.
function findInFile(path, wantKey) {
    if (!storage.fileExists(path)) {
        return undefined;
    }
    let file = storage.openFile(path, "r", "open_existing");
    let carry = "";
    let result = undefined;
    let safetyCounter = 0;
    let SAFETY_LIMIT = 5000; // guards against an unexpected infinite loop
    while (true) {
        safetyCounter = safetyCounter + 1;
        if (safetyCounter > SAFETY_LIMIT) {
            break;
        }
        let chunk = file.read("ascii", READ_CHUNK);
        let gotData = (chunk !== undefined && chunk !== null && chunk.length > 0);
        let data = gotData ? (carry + chunk) : carry;
        let pos = 0;
        while (true) {
            let nl = findFrom(data, "\n", pos);
            if (nl === -1) {
                break;
            }
            let line = data.slice(pos, nl);
            pos = nl + 1;
            if (line.length > 0) {
                let sep = findFrom(line, "::", 0);
                if (sep !== -1 && line.slice(0, sep) === wantKey) {
                    result = line.slice(sep + 2);
                    break;
                }
            }
        }
        carry = data.slice(pos);
        if (result !== undefined) {
            break;
        }
        if (!gotData) {
            // end of file; check any final line with no trailing newline
            if (carry.length > 0) {
                let sep = findFrom(carry, "::", 0);
                if (sep !== -1 && carry.slice(0, sep) === wantKey) {
                    result = carry.slice(sep + 2);
                }
            }
            break;
        }
    }
    file.close();
    return result;
}

// Collects just the keys (not the values) of every "key::value" line in a
// file, for building menu lists cheaply.
function collectKeysFromFile(path) {
    let keys = [];
    if (!storage.fileExists(path)) {
        return keys;
    }
    let file = storage.openFile(path, "r", "open_existing");
    let carry = "";
    let safetyCounter = 0;
    let SAFETY_LIMIT = 5000; // guards against an unexpected infinite loop
    while (true) {
        safetyCounter = safetyCounter + 1;
        if (safetyCounter > SAFETY_LIMIT) {
            break;
        }
        let chunk = file.read("ascii", READ_CHUNK);
        let gotData = (chunk !== undefined && chunk !== null && chunk.length > 0);
        let data = gotData ? (carry + chunk) : carry;
        let pos = 0;
        while (true) {
            let nl = findFrom(data, "\n", pos);
            if (nl === -1) {
                break;
            }
            let line = data.slice(pos, nl);
            pos = nl + 1;
            if (line.length > 0) {
                let sep = findFrom(line, "::", 0);
                if (sep !== -1) {
                    keys.push(line.slice(0, sep));
                }
            }
        }
        carry = data.slice(pos);
        if (!gotData) {
            if (carry.length > 0) {
                let sep = findFrom(carry, "::", 0);
                if (sep !== -1) {
                    keys.push(carry.slice(0, sep));
                }
            }
            break;
        }
    }
    file.close();
    return keys;
}

// ---------------------------------------------------------------------
// Taught-facts storage (small, kept in memory + persisted to the SD card)
// ---------------------------------------------------------------------

function ensureLearnedDir() {
    if (!storage.fileExists(LEARNED_DIR)) {
        storage.makeDirectory(LEARNED_DIR);
    }
}

function appendLearnedLine(line) {
    ensureLearnedDir();
    let file = storage.openFile(LEARNED_PATH, "w", "open_append");
    file.write(line);
    file.close();
}

function rewriteLearnedFile() {
    ensureLearnedDir();
    let file = storage.openFile(LEARNED_PATH, "w", "create_always");
    for (let i = 0; i < learnedDefs.length; i++) {
        file.write("define::" + learnedDefs[i][0] + "::" + learnedDefs[i][1] + "\n");
    }
    for (let i = 0; i < learnedWiki.length; i++) {
        file.write("wiki::" + learnedWiki[i][0] + "::" + learnedWiki[i][1] + "\n");
    }
    file.close();
}

function parseLearnedLine(line) {
    let sep1 = findFrom(line, "::", 0);
    if (sep1 === -1) {
        return;
    }
    let type = line.slice(0, sep1);
    let rest = line.slice(sep1 + 2);
    let sep2 = findFrom(rest, "::", 0);
    if (sep2 === -1) {
        return;
    }
    let key = rest.slice(0, sep2);
    let value = rest.slice(sep2 + 2);
    if (type === "define") {
        learnedDefs.push([key, value]);
    } else if (type === "wiki") {
        learnedWiki.push([key, value]);
    }
}

function loadLearnedFacts() {
    // taught facts are expected to stay small (user-typed), so a single
    // bounded read is fine here, unlike the big built-in data files
    if (!storage.fileExists(LEARNED_PATH)) {
        return;
    }
    let file = storage.openFile(LEARNED_PATH, "r", "open_existing");
    let content = file.read("ascii", 4096);
    file.close();
    if (content === undefined || content === null || content.length === 0) {
        return;
    }
    let pos = 0;
    while (pos < content.length) {
        let nl = findFrom(content, "\n", pos);
        let line;
        if (nl === -1) {
            line = content.slice(pos);
            pos = content.length;
        } else {
            line = content.slice(pos, nl);
            pos = nl + 1;
        }
        if (line.length > 0) {
            parseLearnedLine(line);
        }
    }
}

// removes all entries in `arr` whose key matches `matchKey`; returns true if
// anything was removed. Mutates `arr` in place (no reassignment, no splice).
function removeFromArray(arr, matchKey) {
    let found = false;
    let survivors = [];
    for (let i = 0; i < arr.length; i++) {
        if (arr[i][0] === matchKey) {
            found = true;
        } else {
            survivors.push(arr[i]);
        }
    }
    while (arr.length > 0) {
        arr.pop();
    }
    for (let i = 0; i < survivors.length; i++) {
        arr.push(survivors[i]);
    }
    return found;
}

function lookupLearnedArray(arr, key) {
    // search from the end, so re-teaching a word overrides the older entry
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i][0] === key) {
            return arr[i][1];
        }
    }
    return undefined;
}

function lookupDefine(word) {
    let v = lookupLearnedArray(learnedDefs, word);
    if (v !== undefined) {
        return v;
    }
    return findInFile(DICTIONARY_PATH, word);
}

function lookupWiki(topic) {
    let v = lookupLearnedArray(learnedWiki, topic);
    if (v !== undefined) {
        return v;
    }
    return findInFile(WIKI_PATH, topic);
}

function buildWikiTopicList() {
    let topics = collectKeysFromFile(WIKI_PATH);
    for (let i = 0; i < learnedWiki.length; i++) {
        topics.push(learnedWiki[i][0]);
    }
    return topics;
}

function listLearnedText() {
    let out = "Taught definitions (" + learnedDefs.length.toString() + "):\n";
    for (let i = 0; i < learnedDefs.length; i++) {
        out += "- " + learnedDefs[i][0] + "\n";
    }
    out += "\nTaught wiki topics (" + learnedWiki.length.toString() + "):\n";
    for (let i = 0; i < learnedWiki.length; i++) {
        out += "- " + learnedWiki[i][0] + "\n";
    }
    if (learnedDefs.length === 0 && learnedWiki.length === 0) {
        out += "(nothing taught yet)";
    }
    return out;
}

function helpText() {
    return "Commands:\ndefine <word>\nwiki <topic>\ncalc <expr> (or just type math)\nbattery\nstatus\nteach define <word> = <text>\nteach wiki <topic> = <text>\nforget define <word>\nforget wiki <topic>\nlearned\nhello\n\nTip: underscores work as spaces, e.g. flipper_zero.\nBuilt-in definitions/wiki come from dictionary.txt and wiki.txt on the SD card.\nThis bot is fully offline and has no internet access.";
}

// ---------------------------------------------------------------------
// Chat command handling
// ---------------------------------------------------------------------

function processQuery(text) {
    let lower = text.toLowerCase();

    if (lower.indexOf("teach define ") === 0) {
        let rest = text.slice(13);
        let eq = findFrom(rest, "=", 0);
        if (eq === -1) {
            return "Use: teach define <word> = <definition>";
        }
        let word = trimStr(rest.slice(0, eq)).toLowerCase();
        let def = trimStr(rest.slice(eq + 1));
        if (word.length === 0 || def.length === 0) {
            return "Use: teach define <word> = <definition>";
        }
        learnedDefs.push([word, def]);
        appendLearnedLine("define::" + word + "::" + def + "\n");
        return "Learned! '" + word + "' -> " + def;
    }

    if (lower.indexOf("teach wiki ") === 0) {
        let rest = text.slice(11);
        let eq = findFrom(rest, "=", 0);
        if (eq === -1) {
            return "Use: teach wiki <topic> = <summary>";
        }
        let topic = trimStr(rest.slice(0, eq)).toLowerCase();
        let summary = trimStr(rest.slice(eq + 1));
        if (topic.length === 0 || summary.length === 0) {
            return "Use: teach wiki <topic> = <summary>";
        }
        learnedWiki.push([topic, summary]);
        appendLearnedLine("wiki::" + topic + "::" + summary + "\n");
        return "Learned! Wiki entry for '" + topic + "' saved. It'll show up in the Wikipedia menu next time you open it.";
    }

    if (lower.indexOf("teach") === 0) {
        return "Use:\nteach define <word> = <definition>\nteach wiki <topic> = <summary>";
    }

    if (lower.indexOf("forget define ") === 0) {
        let word = trimStr(text.slice(14)).toLowerCase();
        let removed = removeFromArray(learnedDefs, word);
        if (removed) {
            rewriteLearnedFile();
            return "Forgot the taught definition for '" + word + "'.";
        }
        return "No taught definition found for '" + word + "' (built-in words can't be forgotten).";
    }

    if (lower.indexOf("forget wiki ") === 0) {
        let topic = trimStr(text.slice(12)).toLowerCase();
        let removed = removeFromArray(learnedWiki, topic);
        if (removed) {
            rewriteLearnedFile();
            return "Forgot the taught wiki topic '" + topic + "'.";
        }
        return "No taught wiki topic found for '" + topic + "' (built-in topics can't be forgotten).";
    }

    if (lower === "learned" || lower === "list learned" || lower === "list") {
        return listLearnedText();
    }

    if (lower === "status") {
        let dictOk = storage.fileExists(DICTIONARY_PATH);
        let wikiOk = storage.fileExists(WIKI_PATH);
        let learnedOk = storage.fileExists(LEARNED_PATH);
        return "File check:\ndictionary.txt: " + (dictOk ? "found" : "MISSING") +
            "\nwiki.txt: " + (wikiOk ? "found" : "MISSING") +
            "\nlearned.txt: " + (learnedOk ? "found" : "not created yet") +
            "\n\nExpected at:\n" + DICTIONARY_PATH + "\n" + WIKI_PATH;
    }

    if (lower.indexOf("define ") === 0) {
        let word = text.slice(7).toLowerCase();
        let def = lookupDefine(word);
        if (def !== undefined) {
            return word + ":\n" + def;
        }
        return "No definition for '" + word + "'.\nTeach me with:\nteach define " + word + " = <definition>";
    }

    if (lower.indexOf("wiki ") === 0) {
        let topic = text.slice(5).toLowerCase();
        let info = lookupWiki(topic);
        if (info !== undefined) {
            return info;
        }
        return "No article for '" + topic + "'.\nTeach me with:\nteach wiki " + topic + " = <summary>";
    }

    if (lower.indexOf("calc ") === 0 || lower.indexOf("math ") === 0) {
        let expr = text.slice(5);
        if (isMathExpression(expr)) {
            let val = evalMath(expr);
            return expr + " = " + val.toString();
        }
        return "That doesn't look like a math expression I can parse.";
    }

    if (lower === "battery") {
        return "Battery: " + flipper.getBatteryCharge().toString() + "%";
    }

    if (isMathExpression(text)) {
        let val = evalMath(text);
        return text + " = " + val.toString();
    }

    if (lower === "hello" || lower === "hi") {
        return "Hello, I'm Flopper AI! Try:\ndefine <word>\nwiki <topic>\na math expression\nbattery\nteach define/wiki ...\nor 'help'";
    }

    if (lower === "help") {
        return helpText();
    }

    return "I'm an offline bot with limited built-in knowledge.\nType 'help' to see what I can do, or teach me something new.";
}

// ---------------------------------------------------------------------
// GUI wiring
// ---------------------------------------------------------------------

loadLearnedFacts();

// shared mutable state, passed explicitly into every subscribe() call that
// needs to read or write it (mutating its properties, never reassigning it)
let navState = {
    returnTarget: null,
};

let views = {
    mainMenu: makeSubmenu("Flopper AI", ["Ask / Chat", "Wikipedia", "Battery", "Help", "Exit"]),
    textInput: textInputView.makeWith({
        header: "Ask or teach me:",
        minLength: 0,
        maxLength: 200,
        defaultText: "",
        defaultTextClear: true,
    }),
    answerBox: textBoxView.makeWith({
        focus: "start",
        font: "text",
        text: "",
    }),
    // wikiMenu is created on demand, see mainMenu.chosen below, so that
    // newly taught wiki topics are included every time it's opened
    wikiMenu: null,
};

eventLoop.subscribe(views.mainMenu.chosen, function (_sub, index, gui, views, navState, eventLoop, flipper) {
    if (index === 0) {
        gui.viewDispatcher.switchTo(views.textInput);
    } else if (index === 1) {
        let topics = buildWikiTopicList();
        if (topics.length === 0) {
            topics.push("(no wiki.txt found on SD card)");
        }
        let newWikiMenu = makeSubmenu("Wikipedia Topics", topics);
        views.wikiMenu = newWikiMenu;
        eventLoop.subscribe(newWikiMenu.chosen, function (_sub2, topicIndex, gui, views, navState, topics) {
            let topic = topics[topicIndex];
            let info = lookupWiki(topic);
            views.answerBox.set("text", info !== undefined ? info : "No article found for '" + topic + "'.");
            navState.returnTarget = views.wikiMenu;
            gui.viewDispatcher.switchTo(views.answerBox);
        }, gui, views, navState, topics);
        gui.viewDispatcher.switchTo(newWikiMenu);
    } else if (index === 2) {
        views.answerBox.set("text", "Battery: " + flipper.getBatteryCharge().toString() + "%");
        navState.returnTarget = views.mainMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    } else if (index === 3) {
        views.answerBox.set("text", helpText());
        navState.returnTarget = views.mainMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    } else if (index === 4) {
        eventLoop.stop();
    }
}, gui, views, navState, eventLoop, flipper);

eventLoop.subscribe(views.textInput.input, function (_sub, rawText, gui, views, navState) {
    let text = replaceUnderscoresWithSpaces(rawText);
    let answer = processQuery(text);
    views.answerBox.set("text", answer);
    navState.returnTarget = views.textInput;
    gui.viewDispatcher.switchTo(views.answerBox);
}, gui, views, navState);

// back button handling for every screen
eventLoop.subscribe(gui.viewDispatcher.navigation, function (_sub, _item, gui, views, navState, eventLoop) {
    let cur = gui.viewDispatcher.currentView;
    if (cur === views.mainMenu) {
        eventLoop.stop();
        return;
    }
    if (cur === views.answerBox) {
        gui.viewDispatcher.switchTo(navState.returnTarget);
        return;
    }
    // textInput, wikiMenu, or anything else -> back to the main menu
    gui.viewDispatcher.switchTo(views.mainMenu);
}, gui, views, navState, eventLoop);

gui.viewDispatcher.switchTo(views.mainMenu);
eventLoop.run();
