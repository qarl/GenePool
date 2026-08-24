GENEPOOL SWIMBOTS
Copyright (c) 2021 by Jeffrey Ventrella 

swimbots.com
ventrella.com

----------------------------------------------------------------------------------------------
1. BLURB
Here's the first part of the text from the in-app info page: 

Witness the effects of Darwinian evolution as hundreds of simulated organisms compete for mates and food. Explore this virtual aquarium of proto-swimming robots ('swimbots'), and see how mate preference can affect the course of evolution.

Watch the emergence of a dominant race of swimmers in about 30 minutes. Keep it running for longer and swimming skills will improve, where swimming 'skill' is determined entirely by natural selection. Every time you start a new pool, the outcome will be different.

Learn more about GenePool here: 
https://vimeo.com/562230608

And here:
https://www.ventrella.com/Alife/GenePool.pdf

And here:
https://www.r-bloggers.com/2021/08/intro-to-evolutionary-algorithms-with-r-for-beginners-from-scratch-part-1/

And here:
swimbots.com


----------------------------------------------------------------------------------------------
2. USAGE/LICENSE 

This software is intended for education, game design, and research. You may use, distribute, and modify this code under the terms of the MIT (with the "Commons Clause") License. See the LICENSE file for details). 

One reason I created this web version of GenePool was to allow game developers, researchers, and biology educators with coding ability to create interesting, entertaining, and insightful variations. A basic API to the simulation code (which needs more work) allows developers to construct educational scenarios, game levels, animations, etc., at multiple levels. Please contact me if you have ideas or if you have questions or suggestions about the code.

----------------------------------------------------------------------------------------------
3. THINGS AND STUFF ABOUT THE CODE

When I ported GenePool to the web, I made a point to clearly separate the 'front-end' (all the browser-specific stuff and user interface code) from pure simulation code. Currently there is no (real) back-end, in terms of having some aspect running on a server (although I was breifly using Google Firebase - with the generous help of Scott Schafer - more on that below). 

The simulation code is written in bare-bones Javascript. It doesn't look like typical Javascript found the web. I used an object-oriented approach to encapsulating data internal to the various aspects of the simulation, in order to help it scale. I made it simple in terms of language (it's already complex enough maintaining the interplay between simulation components!) The simulation code starts and runs its own timer. It handles swimbot physics, genetics, foodbits...basically all aspects of the simulation itself.

I plan on doing more development on the API between the simulation and the front-end. Any help on that would be great. This API allows people to develop games and educational simulations by setting tons of ecological and genetic attributes in the simulation at any point in time as the simulation is running. The API allows any degree of control, from simple configuration of initial states to "puppeteering" swimbots in realtime to tell a story (if that's your thing).

For anyone who wants to "Skin" swimbots with alternative rendering schemes; this can be done by replacing the html canvas code in "SwimbotRenderer.js" (in the simulation folder) with an alternate scheme. I suspect this would entail adjsting many other aspects. I may try to make this easier. A good example I can work from is something that Brian Dodd made (stay tuned on that). 

Saving and Loading Swimbot Genes and Simulation States

(The "SoftwareArchitecture" file explains all the files and components of the app)

Older Versions
(to be continued)

(This README file needs more work)

-Jeffrey Ventrella
jeffrey@ventrella.com
ventrella.com



