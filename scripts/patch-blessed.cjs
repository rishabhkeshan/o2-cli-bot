#!/usr/bin/env node
// Patches blessed/lib/widget.js to use static requires instead of dynamic ones
// This is needed for bun build --compile to work

const fs = require('fs');
const path = require('path');

const widgetPath = path.join(__dirname, '..', 'node_modules', 'blessed', 'lib', 'widget.js');
const original = fs.readFileSync(widgetPath, 'utf-8');

// Skip terminal, image, ansiimage, overlayimage, video — they need optional native deps
const staticRequires = `var widget = exports;

widget.Node = widget.node = require('./widgets/node');
widget.Screen = widget.screen = require('./widgets/screen');
widget.Element = widget.element = require('./widgets/element');
widget.Box = widget.box = require('./widgets/box');
widget.Text = widget.text = require('./widgets/text');
widget.Line = widget.line = require('./widgets/line');
widget.ScrollableBox = widget.scrollablebox = require('./widgets/scrollablebox');
widget.ScrollableText = widget.scrollabletext = require('./widgets/scrollabletext');
widget.BigText = widget.bigtext = require('./widgets/bigtext');
widget.List = widget.list = require('./widgets/list');
widget.Form = widget.form = require('./widgets/form');
widget.Input = widget.input = require('./widgets/input');
widget.Textarea = widget.textarea = require('./widgets/textarea');
widget.Textbox = widget.textbox = require('./widgets/textbox');
widget.Button = widget.button = require('./widgets/button');
widget.ProgressBar = widget.progressbar = require('./widgets/progressbar');
widget.FileManager = widget.filemanager = require('./widgets/filemanager');
widget.Checkbox = widget.checkbox = require('./widgets/checkbox');
widget.RadioSet = widget.radioset = require('./widgets/radioset');
widget.RadioButton = widget.radiobutton = require('./widgets/radiobutton');
widget.Prompt = widget.prompt = require('./widgets/prompt');
widget.Question = widget.question = require('./widgets/question');
widget.Message = widget.message = require('./widgets/message');
widget.Loading = widget.loading = require('./widgets/loading');
widget.Listbar = widget.listbar = require('./widgets/listbar');
widget.Log = widget.log = require('./widgets/log');
widget.Table = widget.table = require('./widgets/table');
widget.ListTable = widget.listtable = require('./widgets/listtable');
widget.Layout = widget.layout = require('./widgets/layout');

// Aliases
widget.ListBar = widget.Listbar;
widget.PNG = widget.ANSIImage;
widget.listbar2 = widget.Listbar;
widget.png = widget.ANSIImage;
`;

fs.writeFileSync(widgetPath, staticRequires);
console.log('Patched blessed/lib/widget.js with static requires');
