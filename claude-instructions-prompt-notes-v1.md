Create as new workspace called magic-link.wiredhowse.app using this repository monk24215/wiredhowse-magic-link and this local location (local version of repository) H:\Development\Repositories\magic-link.wiredhowse.app - I'll be creating a free service that people can signup for to create a snippet of code they can place on their website or app that requires the user to submit their email to get a magic link to start a sesssion on their website. Here are the features: 
- Use must have an active session or get a magic link via email or sms that will start a session
- It can keep the variable as a cookie, local storage and/or local session and via database; We want it to be clean, best practices and super smooth and quick for all users
- if none of those local options are available, it will use database (and if nothing seems to work for them,  a json file as a database, if necessary)
- The session length will increase with the number of sessions the user has.1 session 2 hours, 2nd - 4th time 4 hours, 5th - 8th 6 hours and 8th or greater 12 hours
- We can also provide a code with each session so that it can persist over devices using that code -- but if that not secure or safe or useful, another link would work
- We do want to build some sort of profile for them so that they will be able to easily access our other wiredhowse apps as we integrate them
- I will be using Github and Railway -- but after you research the most efficent, elegant and forward thinking strategy, they technologies we utilize will be your decision
- On our side, we don't need any sort of a management interface to manipulate the data, but we will in the future
- 
CUSTOMERS
- Sign up mani profile
- Can use Google Auth or simple form registration for now
- Name, email and verified email by click on link;
- Access to create assets / site/app url
- Turn on service for magic link and given snippet of code for that particular domain
-  system magic link status will read pending, validated/live, in-use X users, turned off (warning, your pages are not being protected by code..or something like that) -- option to clear all sessions (users will have to request new link) 
CUSTOMER B
- these are the users requesting access to CUSTOMER A sites
- when they need support they are given option to close all sessions which clears all their data and archives their sessions data email; If they come back, it will start a new profile and not sure the archived data - that stay in the archive
- Create PDF document for FAQ and support topics for each customer type and I will use that PDF to create custom agents to help them 

- Please spec out this app in whatever detailed mannor is most wfficent for Claude and Claude Code to be successful
- Once specs are approved, Claude and can operate with full permissions and administrative authority without need to check in 
- We can start this on Claude AI and move to Claude code if that is best