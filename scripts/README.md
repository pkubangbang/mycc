# MYCC helper scripts

This folder contains internal scripts that MYCC uses to enhance its capabilities.

## mdcalc

MYCC as a LLM harness is not good at simple math computation.

Instead of writing python which is effective but not informative,
I made a script that receives a specialized md file and compute inside it like using Excel.

## pretty-print

MYCC has crossroad feature: when hitting a turning word, it will trigger a "best of 3"
choice to decide where to go. After the decision making, the original text is continued
by the chosen words.

However, if you would like MYCC to repeat the whole sentence, it will fail because the
same words will trigger the crossroad again, and the continuation is doomed to change.

So I made a script that takes a "crossroad json" file and output the whole sentence
verbosely using bash, which surpass the crossroad behavior.

Later I found this mechanism to worth a generalization: pretty-print's essence is to
add viewing logic to an already structural file, so MYCC will have a better understanding
of the content.

> Note that this feature is under developement, and the final design
> may be drastically different than the current.

## clear-session
A skill called "clear-sessions" will guide MYCC to clean up the session files
to save the disk space. The skill's action is locked down as a script.

MYCC is smart enough to run the script or emulate the script-run based on the
platform it lives.